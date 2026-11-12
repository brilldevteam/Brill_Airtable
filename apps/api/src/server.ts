import { resolve } from "node:path";
import { buildApp } from "./app";
import { openDb } from "./db";

const PORT = Number(process.env.PORT ?? 4000);
const DATA_DIR = process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../.data/pg");

const FILES_DIR = process.env.FILES_DIR ?? resolve(import.meta.dirname, "../../../.data/files");

const db = await openDb(DATA_DIR);
const app = buildApp(db, { logger: true, secureCookies: process.env.NODE_ENV === "production", filesDir: FILES_DIR });

await app.listen({ port: PORT, host: "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
