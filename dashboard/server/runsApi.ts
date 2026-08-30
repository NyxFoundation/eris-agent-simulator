// The runs API: the dashboard's only source of run artifacts.
//
//   /runs/index.json                 run dirs, newest first; `live: true` marks one in progress
//   /runs/<id>/<artifact>            the artifact file itself
//   /runs/<id>/tail/<file>?offset=N  incremental tail of a jsonl/csv artifact (live mode)
//
// It lived inside vite.config.ts, as a dev-server plugin, on the assumption that the dashboard is a
// local viewer over local output. ADR 0021 §5 breaks that assumption: on the practice devnet the
// artifacts are on the coordinator's machine and the participants are not, so the operator hosts
// the dashboard. Same handler, two mounts -- the vite dev server for development, and a small static
// server for hosting (server/serve.ts).
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// A run dir without summary.json is either in progress or dead: summary.json is written at the very
// end of a run, so "no summary but the artifacts still moving" is the live signal. The teardown
// phase (bulk blocks.csv recording, then the reconstruction sweeps) can leave events.jsonl silent
// for tens of seconds while blocks.csv is the file being written — so freshness is judged on the
// newest of the two, with a window generous enough to bridge the quiet stretches. A run that
// briefly dropped off the index mid-teardown would flip the dashboard to the neighboring run and
// strand it there (the live refresh loop stops with the run it lost).
const LIVE_FRESHNESS_MS = 120_000;

// Chunk cap for a tail request: a first tail of a large log would otherwise buffer the whole file
// in memory at once. The client keeps polling with the returned offset until it catches up.
const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Runs are not always at the top of runs/. A run collected from a remote box arrives as a tarball of
 * that box's whole runs/ directory, so it lands at runs/<collection>/runs/<id>/ — every artifact
 * present, one or two levels deeper than a local run. A practice period's segments (ADR 0021 §6)
 * are one level deep for the same reason: runs/<period>/<day>/.
 */
const MAX_RUN_DEPTH = 2;

export type RunEntry = {
  id: string;
  mtimeMs: number;
  live?: boolean;
  /** A competition index (a scenario matrix, or a segmented period) rather than a single world. */
  kind?: "matrix";
};

export function createRunsApi(runsDir: string) {
  const root = path.resolve(runsDir);

  // Resolve a request path to a real file inside runs/, or null. The prefix check alone would let a
  // symlink under runs/ point anywhere on disk; realpath closes that.
  function resolveInside(rel: string): string | null {
    if (rel.includes("\0")) return null;
    const resolved = path.resolve(root, rel);
    const prefix = root + path.sep;
    if (!resolved.startsWith(prefix)) return null;
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
      return real;
    } catch {
      // nonexistent path: keep the prefix-checked resolution so callers can 404 on stat
      return resolved;
    }
  }

  /**
   * A directory is a run when it holds a summary.json, or fresh artifacts still being appended to.
   * A competition directory holds neither: it holds matrix.json, and its scenarios (or segments) are
   * separate run dirs beside it. Both go in the same index, tagged, because the picker offers both —
   * a competition is the outer unit results are read over (ADR 0020), and a run is one draw inside it.
   */
  function classify(rel: string): RunEntry | null {
    const dir = path.join(root, rel);
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

  function collect(rel: string, depth: number): RunEntry[] {
    const dir = path.join(root, rel);
    const children = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    return children.flatMap((child) => {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const run = classify(childRel);
      // A competition dir is not a leaf: its segments live inside it, and they are runs.
      if (run && run.kind !== "matrix") return [run];
      if (depth >= MAX_RUN_DEPTH) return run ? [run] : [];
      let inner: RunEntry[] = [];
      try {
        inner = collect(childRel, depth + 1);
      } catch {
        inner = [];
      }
      return run ? [run, ...inner] : inner;
    });
  }

  function index(): RunEntry[] {
    try {
      return collect("", 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      // no runs/ directory yet — an empty index is the honest answer
      return [];
    }
  }

  /**
   * Handle a request whose path is relative to the /runs mount ("/index.json", "/<id>/summary.json").
   * Returns false when nothing here matched, so the caller can fall through to its own 404.
   */
  return function handle(
    urlPath: string,
    query: string | undefined,
    _req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (urlPath === "/index.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(index()));
      return true;
    }

    // A run id can contain slashes (a collected remote run, or a period's segment), so the split is
    // on the last "/tail/" rather than on the first path segment.
    const tailAt = urlPath.lastIndexOf("/tail/");
    if (tailAt > 0) {
      const rel = `${decodeURIComponent(urlPath.slice(1, tailAt))}/${decodeURIComponent(
        urlPath.slice(tailAt + "/tail/".length),
      )}`;
      const file = resolveInside(rel);
      if (!file || !/\.(jsonl|csv)$/.test(file)) {
        res.statusCode = 403;
        res.end();
        return true;
      }
      const params = new URLSearchParams(query ?? "");
      const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
      // An explicit cap, for readers that only want the head of a file. The run-start and
      // stress-schedule events are written before the first block, so they sit in the first few KB
      // of events.jsonl — reading 128KB of each of a matrix's 35 scenarios costs 4MB where reading
      // the files costs 102MB, for exactly the same answer.
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
      return true;
    }

    const rel = decodeURIComponent(urlPath.replace(/^\//, ""));
    const file = resolveInside(rel);
    if (!file) {
      res.statusCode = 403;
      res.end();
      return true;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    res.setHeader(
      "content-type",
      file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
    );
    fs.createReadStream(file).pipe(res);
    return true;
  };
}
