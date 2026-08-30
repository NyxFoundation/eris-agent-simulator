import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const RUNS_DIR = fileURLToPath(new URL("../runs", import.meta.url));

// A run dir without summary.json is either in progress or dead: summary.json is written at the very
// end of a run, so "no summary but the artifacts still moving" is the live signal. The teardown
// phase (bulk blocks.csv recording, then the reconstruction sweeps) can leave events.jsonl silent
// for tens of seconds while blocks.csv is the file being written — so freshness is judged on the
// newest of the two, with a window generous enough to bridge the quiet stretches. A run that
// briefly dropped off the index mid-teardown would flip the dashboard to the neighboring run and
// strand it there (the live refresh loop stops with the run it lost).
const LIVE_FRESHNESS_MS = 120_000;

// Resolve a request path to a real file inside runs/, or null. The prefix check alone would let a
// symlink under runs/ point anywhere on disk; realpath closes that (local dev server, but cheap).
function resolveInsideRuns(rel: string): string | null {
  if (rel.includes("\0")) return null;
  const resolved = path.resolve(RUNS_DIR, rel);
  const root = path.resolve(RUNS_DIR) + path.sep;
  if (!resolved.startsWith(root)) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(fs.realpathSync(RUNS_DIR) + path.sep)) return null;
    return real;
  } catch {
    // nonexistent path: keep the prefix-checked resolution so callers can 404 on stat
    return resolved;
  }
}

type RunEntry = {
  id: string;
  mtimeMs: number;
  live?: boolean;
  /** A scenario matrix (`backtest --scenarios`) rather than a single world. */
  kind?: "matrix";
};

/**
 * A directory is a run when it holds a summary.json, or fresh artifacts still being appended to.
 * A matrix directory holds neither: it holds matrix.json, and its scenarios are separate run dirs
 * beside it. Both go in the same index, tagged, because the picker offers both — a matrix is the
 * outer unit the competition is actually scored over (ADR 0020) and a run is one draw inside it.
 */
function classifyRun(rel: string): RunEntry | null {
  const dir = path.join(RUNS_DIR, rel);
  try {
    const stat = fs.statSync(path.join(dir, "summary.json"));
    return { id: rel, mtimeMs: stat.mtimeMs };
  } catch {
    try {
      const stat = fs.statSync(path.join(dir, "matrix.json"));
      return { id: rel, mtimeMs: stat.mtimeMs, kind: "matrix" };
    } catch {
      // neither — fall through to the live check below
    }
    // no summary yet — live if any artifact is still being appended to
    const freshest = ["events.jsonl", "blocks.csv"]
      .map((f) => {
        try {
          return fs.statSync(path.join(dir, f)).mtimeMs;
        } catch {
          return 0;
        }
      })
      .reduce((a, b) => Math.max(a, b), 0);
    if (freshest > 0 && Date.now() - freshest < LIVE_FRESHNESS_MS)
      return { id: rel, mtimeMs: freshest, live: true };
    return null;
  }
}

/**
 * Runs are not always at the top of runs/. A run collected from a remote box arrives as a tarball
 * of that box's whole runs/ directory, so it lands at runs/<collection>/runs/<id>/ — every artifact
 * present, one or two levels deeper than a local run. Scanning only the top level meant those runs
 * could not be opened at all, which is exactly the case replay exists for.
 *
 * The id is the path relative to runs/, so the artifact and tail routes address it unchanged.
 */
const MAX_RUN_DEPTH = 2;

function collectRuns(rel: string, depth: number): RunEntry[] {
  const dir = path.join(RUNS_DIR, rel);
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  return children.flatMap((child) => {
    const childRel = rel ? `${rel}/${child.name}` : child.name;
    const run = classifyRun(childRel);
    // A run dir is a leaf: its subdirectories are agents/, not more runs.
    if (run) return [run];
    if (depth >= MAX_RUN_DEPTH) return [];
    try {
      return collectRuns(childRel, depth + 1);
    } catch {
      return [];
    }
  });
}

/**
 * Serves the sibling runs/ directory (same repo, relative path — issue #63):
 *   /runs/index.json           -> run dirs, newest first; `live: true` marks a run in progress
 *   /runs/<id>/<artifact>      -> the artifact file itself
 *   /runs/<id>/tail/<file>?offset=N -> incremental tail of a jsonl/csv artifact (live mode)
 * Dev-server only: the dashboard is a local viewer over local run output.
 */
function runsPlugin(): Plugin {
  return {
    name: "eris-runs",
    configureServer(server) {
      server.middlewares.use("/runs", (req, res, next) => {
        const [urlPath, query] = (req.url ?? "/").split("?");
        const url = urlPath;

        if (url === "/index.json") {
          let entries: RunEntry[] = [];
          try {
            entries = collectRuns("", 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
          } catch {
            // no runs/ directory yet — an empty index is the honest answer
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(entries));
          return;
        }

        // Incremental tail for live mode: /runs/<id>/tail/<file>?offset=N returns the bytes
        // appended since N plus the new offset, so the client polls without refetching the file.
        // Chunks are capped: a first tail of a large log would otherwise buffer the whole file in
        // memory at once — the client keeps polling with the returned offset until it catches up.
        const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;
        // A run id can contain slashes (a collected remote run), so the split is on the last
        // "/tail/" rather than on the first path segment.
        const tailAt = url.lastIndexOf("/tail/");
        const tailMatch =
          tailAt > 0
            ? [url, url.slice(1, tailAt), url.slice(tailAt + "/tail/".length)]
            : null;
        if (tailMatch) {
          const rel = `${decodeURIComponent(tailMatch[1])}/${decodeURIComponent(tailMatch[2])}`;
          const file = resolveInsideRuns(rel);
          if (!file || !/\.(jsonl|csv)$/.test(file)) {
            res.statusCode = 403;
            res.end();
            return;
          }
          const params = new URLSearchParams(query ?? "");
          const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
          // An explicit cap, for readers that only want the head of a file. The run-start and
          // stress-schedule events are written before the first block, so they sit in the first few
          // KB of events.jsonl — reading 128KB of each of a matrix's 35 scenarios costs 4MB where
          // reading the files costs 102MB, for exactly the same answer.
          const limit = Math.min(
            TAIL_CHUNK_BYTES,
            Math.max(1, Number(params.get("limit") ?? 0) || TAIL_CHUNK_BYTES),
          );
          fs.stat(file, (err, stat) => {
            res.setHeader("content-type", "application/json");
            if (err || !stat.isFile()) {
              res.end(JSON.stringify({ offset: 0, text: "", missing: true }));
              return;
            }
            const start = Math.min(offset, stat.size);
            if (start >= stat.size) {
              res.end(JSON.stringify({ offset: stat.size, text: "" }));
              return;
            }
            const end = Math.min(stat.size, start + limit) - 1;
            const chunks: Buffer[] = [];
            fs.createReadStream(file, { start, end })
              .on("data", (c) => chunks.push(c as Buffer))
              .on("end", () => {
                res.end(
                  JSON.stringify({
                    offset: end + 1,
                    text: Buffer.concat(chunks).toString("utf8"),
                  }),
                );
              })
              .on("error", () => {
                res.end(JSON.stringify({ offset: start, text: "" }));
              });
          });
          return;
        }

        const rel = decodeURIComponent(url.replace(/^\//, ""));
        const file = resolveInsideRuns(rel);
        if (!file) {
          res.statusCode = 403;
          res.end();
          return;
        }
        fs.stat(file, (err, stat) => {
          if (err || !stat.isFile()) {
            next();
            return;
          }
          res.setHeader(
            "content-type",
            file.endsWith(".json")
              ? "application/json"
              : "text/plain; charset=utf-8",
          );
          fs.createReadStream(file).pipe(res);
        });
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
