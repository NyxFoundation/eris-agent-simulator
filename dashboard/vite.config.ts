import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createRunsApi } from "./server/runsApi";

const RUNS_DIR = fileURLToPath(new URL("../runs", import.meta.url));

/**
 * Mounts the runs API (server/runsApi.ts) on the dev server. The handler itself is shared with the
 * hosted server, because ADR 0021 §5 needs both: development stays a local viewer over local
 * output, and a practice period is served by whoever the coordinator runs on.
 */
function runsPlugin(): Plugin {
  const handle = createRunsApi(RUNS_DIR);
  return {
    name: "eris-runs",
    configureServer(server) {
      server.middlewares.use("/runs", (req, res, next) => {
        const [urlPath, query] = (req.url ?? "/").split("?");
        if (!handle(urlPath, query, req, res)) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runsPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The dashboard re-scores stored matrices, and the aggregation rules it offers have to be the
      // same code `npm run metrics -- --matrix` runs: two implementations of one ranking is two
      // answers to "who won" with no way to tell which is the real one. core/src/scoring/aggregate.ts
      // is pure (no fs, no chain) precisely so it can be reused this way -- see its header.
      "@core": fileURLToPath(new URL("../core/src", import.meta.url)),
      // The method-name table (ADR 0021 §4) is built from the venue ABIs the sdk holds, and the
      // live view decodes calldata in the browser -- so it needs the same table the coordinator
      // used, not a second copy that can drift from it.
      "@sdk": fileURLToPath(new URL("../sdk/src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local Blockscout explorer (npm run explorer, :3100). Proxying keeps the
      // availability probe same-origin; when the explorer is down the proxied
      // request fails and the dashboard silently drops its deep links.
      "/blockscout": {
        target: "http://localhost:3100",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/blockscout/, ""),
      },
    },
  },
});
