import { defineConfig } from "vitest/config";

// Each test file boots its own in-memory Postgres (WASM) and some run real BullMQ workers, so cap
// parallelism: on an 8 GB machine, unbounded forks swap and turn into timeouts.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60000, hookTimeout: 90000, pool: "forks", maxWorkers: 3 },
});
