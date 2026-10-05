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


/**
 * Serves a directory of the repository's own Markdown as one module: every entry, both languages.
 *
 * The dashboard shows the update history (pages/UpdatesPage.tsx) and the Q&A (pages/QaPage.tsx),
 * and the entries accumulate -- one page holding all of them stops being readable after a few.
 * Enumerating the directory here means adding an entry is adding a file: no page edit, no list to
 * keep in step with the files.
 *
 * Reading them here rather than importing across the directory line also keeps every module inside
 * this Vite root. Importing `../../docs/*.md?raw` puts the importing subtree behind `/@fs/`, which
 * is served with its own copy of react -- the page then renders nothing and the console says "more
 * than one copy of React in the same app" (measured 2026-10-03).
 */
function docsPlugin(opts: {
  name: string;
  id: string;
  dir: string;
  /** Which files are entries (`.en.md` is an entry's translation); README is for GitHub readers. */
  entry: RegExp;
  /** The entry's id from its file name, the same for the two languages. */
  slugOf: (file: string) => string;
}): Plugin {
  const { name, id: ID, dir, entry, slugOf } = opts;
  return {
    name,
    resolveId(id) {
      return id === ID ? "\0" + ID : null;
    },
    load(id) {
      if (id !== "\0" + ID) return null;
      const files = readdirSync(dir).filter((f) => entry.test(f)).sort();
      const entries = files.map((f) => {
        const locale = f.endsWith(".en.md") ? "en" : "ja";
        this.addWatchFile(join(dir, f));
        return {
          slug: slugOf(f),
          locale,
          text: readFileSync(join(dir, f), "utf8"),
        };
      });
      return `export default ${JSON.stringify(entries)};`;
    },
    configureServer(server) {
      // A new file in the directory is a new entry, and the module that lists them has to be told.
      server.watcher.add(dir);
      server.watcher.on("add", (file) => {
        if (!file.startsWith(dir)) return;
        const mod = server.moduleGraph.getModuleById("\0" + ID);
        if (mod) server.reloadModule(mod);
      });
    },
  };
}

/** `docs/updates/`: `<YYYY-MM-DD>.md` is an entry. The page sorts them newest first. */
const updatesPlugin = (): Plugin =>
  docsPlugin({
    name: "eris-updates",
    id: "virtual:eris-updates",
    dir: fileURLToPath(new URL("../docs/updates", import.meta.url)),
    entry: /^\d{4}-\d{2}-\d{2}(\.en)?\.md$/,
    slugOf: (f) => f.slice(0, 10),
  });

/** `docs/qa/`: `<NN>-<name>.md` is a topic. The page shows them in file order. */
const qaPlugin = (): Plugin =>
  docsPlugin({
    name: "eris-qa",
    id: "virtual:eris-qa",
    dir: fileURLToPath(new URL("../docs/qa", import.meta.url)),
    entry: /^\d{2}-[a-z0-9-]+(\.en)?\.md$/,
    slugOf: (f) => f.replace(/(\.en)?\.md$/, ""),
  });

export default defineConfig({
  plugins: [react(), tailwindcss(), runsPlugin(), updatesPlugin(), qaPlugin()],
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
