// Production build of the API: one ESM file (dist/server.mjs) that runs on plain Node 22.
// Our own TypeScript (including the shared package) is bundled in; the npm dependencies stay
// as normal imports from node_modules (some, like PGlite and sharp, ship binary/WASM files).
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@brill/"));

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  // Some bundled code uses require(); give ESM output a require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
