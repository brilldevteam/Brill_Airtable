import { newId, type AttachmentInfo } from "@brill/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { z } from "zod";
import { tableAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { safeFetch } from "./safeFetch";

/**
 * Attachment storage on local disk:
 *   <filesDir>/<attId>            original bytes
 *   <filesDir>/<attId>.thumb.webp thumbnail (images only)
 * The `attachments` table holds the metadata. Cells of attachment fields store attachment ids.
 * Swap this module for S3/MinIO later without touching the rest of the app.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const THUMB_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff"]);
/** Types a browser could execute as a page — always downloaded, never shown inline. */
const UNSAFE_INLINE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/;
const INLINE_OK = /^(image\/|application\/pdf$|text\/plain$|video\/|audio\/)/;

/** Browsers sometimes send "application/octet-stream"; fill in common types from the extension. */
const EXT_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
};
function fixMime(mime: string, filename: string) {
  const m = (mime || "").toLowerCase();
  if (m && m !== "application/octet-stream") return m;
  return EXT_MIME[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export const attachmentUrl = (id: string, filename: string) => `/api/attachments/${id}/${encodeURIComponent(filename)}`;

export function toAttachmentInfo(r: any): AttachmentInfo {
  return {
    id: r.id,
    filename: r.filename,
    mime: r.mime,
    size: Number(r.size),
    width: r.width ?? null,
    height: r.height ?? null,
    url: attachmentUrl(r.id, r.filename),
    thumbUrl: r.has_thumb ? attachmentUrl(r.id, r.filename) + "?thumb=1" : null,
  };
}

export async function attachmentInfos(db: Db, ids: string[]): Promise<Record<string, AttachmentInfo>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return {};
  const rows = await db.query(`SELECT * FROM attachments WHERE id = ANY($1::text[])`, [unique]);
  return Object.fromEntries(rows.map((r: any) => [r.id, toAttachmentInfo(r)]));
}

/** Throws 422 unless every id is an attachment uploaded to this table. */
export async function assertAttachments(db: Db, tableId: string, fieldName: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db.query(`SELECT id FROM attachments WHERE table_id=$1 AND id = ANY($2::text[])`, [tableId, ids]);
  if (rows.length !== new Set(ids).size) throw new HttpError(422, `${fieldName}: some attachments don't exist`);
}

function safeFilename(name: string) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  return cleaned || "file";
}

/** Counts bytes and fails once the limit is passed. */
function sizeLimit(max: number, label: string) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new HttpError(413, `"${label}" is larger than ${max / 1024 / 1024} MB`));
      else cb(null, chunk);
    },
  });
}

const commentBody = z.object({ body: z.string().trim().min(1).max(5000) });

export type SaveFile = (tableId: string, userId: string | null, filename: string, mime: string, stream: Readable, shareId?: string | null) => Promise<AttachmentInfo>;

export function registerFiles(app: FastifyInstance, db: Db, filesDir: string): { saveFile: SaveFile; pathOf: (id: string, thumb?: boolean) => string } {
  const pathOf = (id: string, thumb = false) => join(filesDir, thumb ? `${id}.thumb.webp` : id);

  /** Store a stream as a new attachment of a table (thumbnail for images). */
  async function saveFile(tableId: string, userId: string | null, filename: string, mimeIn: string, stream: Readable, shareId: string | null = null): Promise<AttachmentInfo> {
    await mkdir(filesDir, { recursive: true });
    const id = newId("att");
    const dest = pathOf(id);
    const name = safeFilename(filename);
    try {
      await pipeline(stream, sizeLimit(MAX_FILE_BYTES, name), createWriteStream(dest));
    } catch (e) {
      await rm(dest, { force: true });
      throw e;
    }
    if ((stream as any).truncated) {
      await rm(dest, { force: true });
      throw new HttpError(413, `"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const size = (await stat(dest)).size;
    const mime = fixMime(mimeIn, name);
    let width: number | null = null;
    let height: number | null = null;
    let hasThumb = false;
    if (THUMB_TYPES.has(mime)) {
      try {
        const meta = await sharp(dest).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
        await sharp(dest, { animated: false }).rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 78 }).toFile(pathOf(id, true));
        hasThumb = true;
      } catch {
        // Not a readable image after all; keep it as a plain file.
      }
    }
    const row = await db.one(
      `INSERT INTO attachments (id, table_id, filename, mime, size, width, height, has_thumb, created_by, share_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, tableId, name, mime, size, width, height, hasThumb, userId, shareId],
    );
    return toAttachmentInfo(row);
  }

  async function attachmentWithAccess(userId: string, id: string, min: "read" | "commenter" | "editor") {
    const row = await db.one(`SELECT * FROM attachments WHERE id=$1`, [id]);
    if (!row) throw new HttpError(404, "Not found");
    await tableAccess(db, userId, row.table_id, min);
    return row;
  }

  /** Upload one or more files to a table (multipart/form-data, field name "file"). */
  app.post("/api/tables/:tableId/attachments", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    await tableAccess(db, user.id, tableId, "editor");
    if (!req.isMultipart()) throw new HttpError(415, "Send files as multipart/form-data");
    const saved: AttachmentInfo[] = [];
    for await (const part of req.files({ limits: { fileSize: MAX_FILE_BYTES, files: 20 } })) {
      saved.push(await saveFile(tableId, user.id, part.filename, part.mimetype, part.file));
    }
    if (!saved.length) throw new HttpError(400, "No files were sent");
    return { attachments: saved };
  });

  /** Add a file from a web link. The server downloads it (safely — see safeFetch). */
  app.post("/api/tables/:tableId/attachments/from-url", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const { url } = z.object({ url: z.string().trim().url().max(2000) }).parse(req.body);
    await tableAccess(db, user.id, tableId, "editor");
    const fetched = await safeFetch(url);
    if (fetched.length !== null && fetched.length > MAX_FILE_BYTES) {
      fetched.stream.destroy();
      throw new HttpError(413, `That file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    return { attachments: [await saveFile(tableId, user.id, fetched.filename, fetched.mime, fetched.stream)] };
  });

  /** Rename a file. */
  app.patch("/api/attachments/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { filename } = z.object({ filename: z.string().trim().min(1).max(200) }).parse(req.body);
    await attachmentWithAccess(user.id, id, "editor");
    const row = await db.one(`UPDATE attachments SET filename=$2 WHERE id=$1 RETURNING *`, [id, safeFilename(filename)]);
    return { attachment: toAttachmentInfo(row) };
  });

  /** Comments on a file. */
  app.get("/api/attachments/:id/comments", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await attachmentWithAccess(user.id, id, "read");
    const comments = await db.query(
      `SELECT c.id, c.body, c.created_at AS "createdAt", c.user_id AS "userId", u.name AS "userName"
       FROM attachment_comments c JOIN users u ON u.id = c.user_id WHERE c.attachment_id=$1 ORDER BY c.created_at`,
      [id],
    );
    return { comments: comments.map((c: any) => ({ ...c, createdAt: new Date(c.createdAt).toISOString() })) };
  });

  app.post("/api/attachments/:id/comments", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { body } = commentBody.parse(req.body);
    await attachmentWithAccess(user.id, id, "commenter");
    const c = await db.one(
      `INSERT INTO attachment_comments (id, attachment_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [newId("cmt"), id, user.id, body],
    );
    return { comment: { id: c.id, body, createdAt: new Date(c.created_at).toISOString(), userId: user.id, userName: user.name } };
  });

  app.delete("/api/attachment-comments/:commentId", async (req) => {
    const user = requireUser(req);
    const { commentId } = req.params as { commentId: string };
    const c = await db.one(`SELECT * FROM attachment_comments WHERE id=$1`, [commentId]);
    if (!c) throw new HttpError(404, "Not found");
    await attachmentWithAccess(user.id, c.attachment_id, "read");
    if (c.user_id !== user.id) throw new HttpError(403, "You can only delete your own comments");
    await db.query(`DELETE FROM attachment_comments WHERE id=$1`, [commentId]);
    return { ok: true };
  });

  /**
   * Download / show a file. Supports HTTP range requests so videos can seek.
   * ?thumb=1 serves the thumbnail; ?download=1 forces a download.
   */
  app.get("/api/attachments/:id/:name", async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const q = req.query as { thumb?: string; download?: string };
    const thumb = q.thumb === "1";
    const row = await attachmentWithAccess(user.id, id, "read");
    return streamAttachment(row, thumb, q.download === "1", req, reply, pathOf);
  });
  return { saveFile, pathOf };
}

/** Send an attachment (or its thumbnail) with safe headers and HTTP range support. */
export async function streamAttachment(
  row: any, thumb: boolean, forceDownload: boolean, req: FastifyRequest, reply: FastifyReply, pathOf: (id: string, thumb?: boolean) => string,
) {
  const id: string = row.id;
  const q = { download: forceDownload ? "1" : undefined };
  if (thumb && !row.has_thumb) throw new HttpError(404, "No thumbnail");

  const file = pathOf(id, thumb);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new HttpError(404, "File is missing on the server");
  }
  const mime: string = thumb ? "image/webp" : row.mime;
  const unsafe = UNSAFE_INLINE.test(mime);
  const inline = !unsafe && INLINE_OK.test(mime) && q.download !== "1";
  const encoded = encodeURIComponent(row.filename);
  // PDFs need the browser's viewer, which a sandboxed CSP blocks; they can't run page scripts anyway.
  // Video/audio opened in their own tab: the browser's player page re-requests the file, and a
  // sandboxed page has a "null" origin, so Chrome blocks that request (CORS) and nothing plays.
  // Media files can't run scripts, so they don't need the sandbox.
  const media = inline && /^(video|audio)\//.test(mime);
  const csp = mime === "application/pdf"
    ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'"
    : media
      ? "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  reply
    .header("Content-Type", unsafe ? "application/octet-stream" : mime)
    .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encoded}"; filename*=UTF-8''${encoded}`)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", csp)
    .header("Accept-Ranges", "bytes")
    .header("Cache-Control", "private, max-age=86400");

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return reply.status(416).header("Content-Range", `bytes */${size}`).send();
    }
    return reply
      .status(206)
      .header("Content-Range", `bytes ${start}-${end}/${size}`)
      .header("Content-Length", end - start + 1)
      .send(createReadStream(file, { start, end }));
  }
  return reply.header("Content-Length", size).send(createReadStream(file));
}
