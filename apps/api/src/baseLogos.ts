import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { baseAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/**
 * A base can show a client's logo instead of an icon. The upload is re-drawn by sharp as a
 * 256×256 WebP (so whatever was uploaded, what we serve is a plain image) and kept in
 * <filesDir>/logos. Only people who can open the base can see it.
 */
export function registerBaseLogos(app: FastifyInstance, db: Db, filesDir: string) {
  const dir = join(filesDir, "logos");
  const fileOf = (name: string) => join(dir, name);

  app.post("/api/bases/:baseId/logo", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "creator");
    if (!req.isMultipart()) throw new HttpError(415, "Send the logo as multipart/form-data");
    const part = await req.file({ limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });
    if (!part) throw new HttpError(400, "No file was sent");
    if (!/^image\//.test(part.mimetype)) throw new HttpError(400, "The logo must be an image (PNG, JPG, WebP or SVG)");
    const buf = await part.toBuffer().catch(() => { throw new HttpError(413, "The logo must be under 5 MB"); });
    let webp: Buffer;
    try {
      webp = await sharp(buf, { density: 300 }).resize(256, 256, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
    } catch {
      throw new HttpError(400, "That image couldn't be read");
    }
    await mkdir(dir, { recursive: true });
    const name = `${baseId}-${randomBytes(6).toString("hex")}.webp`;
    await writeFile(fileOf(name), webp);
    const old = await db.one<{ logo: string | null }>(`SELECT logo FROM bases WHERE id=$1`, [baseId]);
    await db.query(`UPDATE bases SET logo=$2 WHERE id=$1`, [baseId, name]);
    if (old?.logo) await rm(fileOf(old.logo), { force: true });
    return { logo: name };
  });

  app.delete("/api/bases/:baseId/logo", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "creator");
    const old = await db.one<{ logo: string | null }>(`SELECT logo FROM bases WHERE id=$1`, [baseId]);
    await db.query(`UPDATE bases SET logo=NULL WHERE id=$1`, [baseId]);
    if (old?.logo) await rm(fileOf(old.logo), { force: true });
    return { ok: true };
  });

  app.get("/api/bases/:baseId/logo/:name", async (req, reply) => {
    const user = requireUser(req);
    const { baseId, name } = req.params as { baseId: string; name: string };
    await baseAccess(db, user.id, baseId, "read");
    const row = await db.one<{ logo: string | null }>(`SELECT logo FROM bases WHERE id=$1`, [baseId]);
    if (!row?.logo || row.logo !== name) throw new HttpError(404, "Not found");
    return reply
      .header("Content-Type", "image/webp")
      .header("Cache-Control", "private, max-age=31536000, immutable") // the name changes with every upload
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(createReadStream(fileOf(row.logo)));
  });
}
