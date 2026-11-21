import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Production: the API also serves the built web app (apps/web/dist), so one Node process on one
 * port runs everything — which is what a CloudPanel "Node.js site" (or any reverse proxy) expects.
 *
 *  - /api/*                → the API (unknown paths are a JSON 404)
 *  - /assets/*             → hashed build files, cached for a year
 *  - any other GET         → the file if it exists, else index.html (the app's own routes:
 *                            /base/…, /f/…, /v/…, /invite/…, /reset-password/…)
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** What the web app may load: only its own files and API (plus data:/blob: images and media). */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function registerWebApp(app: FastifyInstance, webDir: string) {
  const root = resolve(webDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) throw new Error(`WEB_DIR has no index.html: ${root} — run "pnpm build" first`);

  app.setNotFoundHandler((req, reply) => {
    const path = decodeURIComponent((req.url.split("?")[0] ?? "/"));
    if (path.startsWith("/api/") || path === "/api" || (req.method !== "GET" && req.method !== "HEAD")) {
      return reply.status(404).send({ error: "Not found" });
    }
    // Resolve inside the build folder only (no ../ escapes).
    const file = normalize(join(root, path));
    const inside = file === root || file.startsWith(root + sep);
    let target = index;
    if (inside && path !== "/" && existsSync(file) && statSync(file).isFile()) target = file;
    const isIndex = target === index;
    reply
      .header("content-type", TYPES[extname(target).toLowerCase()] ?? "application/octet-stream")
      .header("cache-control", isIndex ? "no-cache" : path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600")
      .header("content-security-policy", WEB_CSP);
    return reply.send(createReadStream(target));
  });
}
