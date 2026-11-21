import { defineConfig } from "vitest/config";

// Each test file starts its own database (and runs every migration), and files run in parallel,
// so setup can take a while on a busy machine.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000 },
});
