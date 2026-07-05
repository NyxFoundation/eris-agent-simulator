import { defineConfig } from "vitest/config";

// The E2E checks assume an already-running anvil plus a deployed deployments.json.
// Because all tests share the same anvil state, both file-level and test-level
// parallelism are disabled so they run sequentially. Timeouts are set generously to
// accommodate swap+waitTx and GMX reads.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
