import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  competitionsFromEnv,
  createRunsApi,
  modeFromEnv,
} from "./server/runsApi";

const RUNS_DIR = fileURLToPath(new URL("../runs", import.meta.url));

/**
 * Mounts the runs API (server/runsApi.ts) on the dev server. The handler itself is shared with the
 * hosted server, because ADR 0021 §5 needs both: development stays a local viewer over local
 * output, and a practice period is served by whoever the coordinator runs on.
 */
function runsPlugin(): Plugin {
  // The same ERIS_DASHBOARD_AUDIENCE / ERIS_DASHBOARD_STANDINGS / ERIS_DASHBOARD_COMPETITIONS
  // switches as the hosted server, so the public view can be exercised locally before it is exposed.
  const competitions = competitionsFromEnv();
  const handle = createRunsApi(RUNS_DIR, {
    ...modeFromEnv(),
    ...(competitions ? { competitions } : {}),
  });
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


const UPDATES_DIR = fileURLToPath(new URL("../docs/updates", import.meta.url));
const UPDATES_ID = "virtual:eris-updates";

/**
 * Serves `docs/updates/` as one module: every entry, both languages, newest first.
 *
 * The dashboard shows the update history (pages/UpdatesPage.tsx), and the entries accumulate -- one
 * page holding all of them stops being readable after a few. Enumerating the directory here means
 * adding an entry is adding a file: no page edit, no list to keep in step with the files.
 *
 * Reading them here rather than importing across the directory line also keeps every module inside
 * this Vite root. Importing `../../docs/*.md?raw` puts the importing subtree behind `/@fs/`, which
 * is served with its own copy of react -- the page then renders nothing and the console says "more
 * than one copy of React in the same app" (measured 2026-10-03).
 */
function updatesPlugin(): Plugin {
  return {
    name: "eris-updates",
    resolveId(id) {
      return id === UPDATES_ID ? "\0" + UPDATES_ID : null;
    },
    load(id) {
      if (id !== "\0" + UPDATES_ID) return null;
      // `<YYYY-MM-DD>.md` is an entry; `.en.md` is its translation; README is the index for
      // somebody reading the directory on GitHub, and the dashboard builds its own.
      const files = readdirSync(UPDATES_DIR)
        .filter((f) => /^\d{4}-\d{2}-\d{2}(\.en)?\.md$/.test(f))
        .sort()
        .reverse();
      const entries = files.map((f) => {
        const slug = f.slice(0, 10);
        const locale = f.endsWith(".en.md") ? "en" : "ja";
        this.addWatchFile(join(UPDATES_DIR, f));
        return {
          slug,
          locale,
          text: readFileSync(join(UPDATES_DIR, f), "utf8"),
        };
      });
      return `export default ${JSON.stringify(entries)};`;
    },
    configureServer(server) {
      // A new file in the directory is a new entry, and the module that lists them has to be told.
      server.watcher.add(UPDATES_DIR);
      server.watcher.on("add", (file) => {
        if (!file.startsWith(UPDATES_DIR)) return;
        const mod = server.moduleGraph.getModuleById("\0" + UPDATES_ID);
        if (mod) server.reloadModule(mod);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runsPlugin(), updatesPlugin()],
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
