// The runs API: the dashboard's only source of run artifacts.
//
//   /runs/index.json                 run dirs, newest first; `live: true` marks one in progress
//   /runs/mode.json                  how this server is configured to show them (audience / standings)
//   /runs/<id>/<artifact>            the artifact file itself
//   /runs/<id>/tail/<file>?offset=N  incremental tail of a jsonl/csv artifact (live mode)
//
// It lived inside vite.config.ts, as a dev-server plugin, on the assumption that the dashboard is a
// local viewer over local output. ADR 0021 §5 breaks that assumption: on the practice devnet the
// artifacts are on the coordinator's machine and the participants are not, so the operator hosts
// the dashboard. Same handler, two mounts -- the vite dev server for development, and a small static
// server for hosting (server/serve.ts).
//
// Audience mode (2026-09-06: the dashboard is public during the trial period and the live week).
// The run directory is the complete record and stays that way -- it is what rules §7.2 publishes
// after the results. What a competition in progress must not publish is removed *here*, at the one
// place every reader goes through, rather than in the UI: a panel that does not render a file is
// not the same as a file nobody can fetch.
//   - files: only the artifacts the pages need. Decision logs (a participant's own reasoning and
//     their not-yet-included bids -- rules §2.6 is a priority-fee auction) and raw LLM exchanges are
//     never served; neither is anything not on the list
//   - events.jsonl: the seeds (§3.3, §7.2), the calibration warning (it names crash magnitudes), the
//     ground truth of regime-7 pools (§3.2: whether a pool is rigged is the participant's to find
//     out), a participant's stderr, and the *future* half of the stress schedule are stripped. Past
//     windows stay: they already happened to everyone
//   - matrix.json / standings.json / summary.json: regime and seed become "hidden" while the
//     competition is a scenario matrix (§3.3: the scenario of an epoch is not announced; equal
//     regime counts would let the remaining ones be inferred). A practice period's segments are not
//     scenarios and keep their date labels
// `standings: false` is the trial environment's rule §4.7 ("posts no standings"); the server only
// reports it and the UI honours it, because the numbers behind a standing are the same numbers
// the scenario pages show.
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { createGzip } from "node:zlib";
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

// The index walks runs/ with a stat per directory. One viewer polling it is nothing; an audience
// polling it every few seconds is the same walk repeated for the same answer, so it is held for a
// moment. Short enough that a run appearing or going live shows up within a poll interval.
const INDEX_CACHE_MS = 3_000;

// Bytes read off the end of blocks.csv to learn the current block of a live run. A row is ~150
// bytes; this is dozens of rows, which is plenty to find one complete line.
const BLOCKS_TAIL_BYTES = 8 * 1024;

// Cache lifetimes. A finished run's artifacts never change (immutable); a competition index and a
// live run's files are rewritten while it runs; the index and the tail are the poll targets.
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_SHORT = "public, max-age=5";
const CACHE_NONE = "no-store";

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

/** What /runs/mode.json reports, so the UI can say why a panel is absent rather than render it empty. */
export type DashboardMode = {
  /** The server withholds what a competition in progress must not publish (see the header). */
  audience: boolean;
  /** False for the trial environment: rules §4.7, it posts no standings. */
  standings: boolean;
};

export type RunsApiOptions = Partial<DashboardMode>;

/**
 * ERIS_DASHBOARD_AUDIENCE=1   serve for people who are not the operator (default: off — a local
 *                             viewer over local output, the development path)
 * ERIS_DASHBOARD_STANDINGS=0  do not post standings (the trial environment, rules §4.7)
 */
export function modeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DashboardMode {
  const on = (v: string | undefined) => v === "1" || v === "true";
  const off = (v: string | undefined) => v === "0" || v === "false";
  return {
    audience: on(env.ERIS_DASHBOARD_AUDIENCE),
    standings: !off(env.ERIS_DASHBOARD_STANDINGS),
  };
}

// The artifacts the pages read. Everything else under a run dir is either a participant's
// (agents/<id>.jsonl, agents/<id>.llm.jsonl), the environment's answer key (disclosures/), or
// something a future writer adds that nobody has decided to publish yet.
const AUDIENCE_FILES = new Set([
  "summary.json",
  "matrix.json",
  "standings.json",
  "market.json",
  "market.jsonl",
  "blocks.csv",
  "events.jsonl",
  "epochs.jsonl",
  "manifest.json",
  "current-segment",
]);

const HIDDEN_REGIME = "hidden";

function audienceAllows(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.includes("agents") || parts.includes("disclosures")) return false;
  return AUDIENCE_FILES.has(base);
}

type Json = Record<string, unknown>;

/** Whether a competition index describes scenarios (hide regime/seed) or a period's segments (keep). */
function hidesScenarios(file: Json): boolean {
  return file.resetUnit !== "continuous";
}

function redactScenario(s: Json, index: number): Json {
  const ordinal = typeof s.s === "number" ? s.s : index + 1;
  const { label: _label, ...rest } = s;
  return { ...rest, regime: HIDDEN_REGIME, seed: 0, s: ordinal };
}

/** matrix.json for the audience: the epochs, without which scenario each one was. */
function redactMatrix(file: Json): Json {
  if (!hidesScenarios(file) || !Array.isArray(file.scenarios)) return file;
  return {
    ...file,
    scenarios: (file.scenarios as Json[]).map(redactScenario),
  };
}

/** standings.json carries regime/seed per epoch too. */
function redactStandings(file: Json): Json {
  if (!Array.isArray(file.epochs)) return file;
  return {
    ...file,
    epochs: (file.epochs as Json[]).map((e) => ({
      ...e,
      regime: HIDDEN_REGIME,
      seed: 0,
    })),
  };
}

/** summary.json: the seeds, and a participant's stderr (their process, their words). */
function redactSummary(file: Json): Json {
  const { seed: _seed, flowSeed: _flowSeed, ...rest } = file;
  if (Array.isArray(rest.agents)) {
    rest.agents = (rest.agents as Json[]).map((a) => {
      const { stderrTail: _stderr, ...agent } = a;
      return agent;
    });
  }
  return rest;
}

const REDACTED_JSON: Record<string, (file: Json) => Json> = {
  "matrix.json": redactMatrix,
  "standings.json": redactStandings,
  "summary.json": redactSummary,
};

/**
 * One events.jsonl line for the audience, or null to drop it. `currentBlock` is the chain height the
 * run has reached (null when unknown), which decides how much of the stress schedule is history.
 */
export type SchedulePolicy =
  /** Keep windows that have closed by `currentBlock` (a practice period: the past is public). */
  | { kind: "past"; currentBlock: number | null }
  /**
   * Drop the schedule entirely: the run is one epoch of a scenario matrix, and even a closed
   * window's kind ("crash", "whale") names the regime rules §3.3 does not announce.
   */
  | { kind: "none" };

export function redactEventLine(
  line: string,
  policy: SchedulePolicy,
): string | null {
  let event: Json;
  try {
    event = JSON.parse(line) as Json;
  } catch {
    // Not an event (a torn or foreign line). Nothing to redact and nothing to reveal: keep it as the
    // client would have seen it.
    return line;
  }
  switch (event.type) {
    case "run_started_realtime": {
      const { seed: _s, flowSeed: _f, ...rest } = event;
      return JSON.stringify(rest);
    }
    case "stress_schedule": {
      // The plan is drawn from the seed before block one. On a practice period what has already
      // happened is public in the price series anyway, and what has not is exactly what the
      // manifest withholds (ADR 0021 §1). In a scenario matrix the kind of a window names the
      // regime, which is what §3.3 keeps from the audience, so nothing of the plan is served.
      if (policy.kind === "none") return null;
      const currentBlock = policy.currentBlock;
      if (currentBlock === null || !Array.isArray(event.events)) return null;
      const start =
        typeof event.runStartBlock === "number" ? event.runStartBlock : 0;
      const past = (event.events as Json[]).filter(
        (w) =>
          typeof w.endBlock === "number" && start + w.endBlock <= currentBlock,
      );
      if (past.length === 0) return null;
      return JSON.stringify({
        ...event,
        events: past,
        redacted: "future windows",
      });
    }
    case "stress_calibration_warning":
    case "vulnerability_exploited":
      return null;
    case "pool_created": {
      const {
        rigged: _r,
        rugBps: _rb,
        rugThresholdUnits: _rt,
        baitBps: _bb,
        ...rest
      } = event;
      return JSON.stringify(rest);
    }
    default: {
      if ("stderrTail" in event) {
        const { stderrTail: _e, ...rest } = event;
        return JSON.stringify(rest);
      }
      return line;
    }
  }
}

export function createRunsApi(runsDir: string, options: RunsApiOptions = {}) {
  const root = path.resolve(runsDir);
  const mode: DashboardMode = {
    audience: options.audience ?? false,
    standings: options.standings ?? true,
  };

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

  let indexCache: { at: number; entries: RunEntry[] } | null = null;
  function index(): RunEntry[] {
    if (indexCache && Date.now() - indexCache.at < INDEX_CACHE_MS)
      return indexCache.entries;
    let entries: RunEntry[];
    try {
      entries = collect("", 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      // no runs/ directory yet — an empty index is the honest answer
      entries = [];
    }
    indexCache = { at: Date.now(), entries };
    return entries;
  }

  /** The run dir a file belongs to: the nearest ancestor that is a run or a competition. */
  function isFinishedRunFile(file: string): boolean {
    const dir = path.dirname(file);
    const base = path.basename(file);
    // A competition's own index is rewritten while it runs; a finished run's files are not.
    if (base === "matrix.json" || base === "standings.json") return false;
    try {
      fs.statSync(path.join(dir, "summary.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The current block of the run a file belongs to, off the end of its blocks.csv (columns:
   * round,blockNumber,...). Null when the file is missing or has no complete row yet. Used only to
   * split the stress schedule into past and future for the audience.
   */
  function currentBlockOf(file: string): number | null {
    const blocks = path.join(path.dirname(file), "blocks.csv");
    let fd: number | null = null;
    try {
      const size = fs.statSync(blocks).size;
      if (size === 0) return null;
      fd = fs.openSync(blocks, "r");
      const start = Math.max(0, size - BLOCKS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      // The last element is "" (trailing newline) or a row still being written; the one before is
      // complete. A header row (round,blockNumber,...) yields NaN and is skipped.
      for (let i = lines.length - 1; i >= 0; i--) {
        const cols = lines[i].split(",");
        if (cols.length < 2) continue;
        const n = Number(cols[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /**
   * Which run this file belongs to, and how much of its stress schedule the audience may see. A
   * scenario matrix's epoch (`resetUnit: scenario`, recorded in summary.json at the end and in
   * run_started_realtime from the start) gets none of it; a continuous world (a practice period)
   * gets the windows that have closed. A run that says neither is treated as a scenario: the
   * cautious default, since the cost of the other mistake is a published regime.
   */
  function schedulePolicyOf(file: string): SchedulePolicy {
    const dir = path.dirname(file);
    let resetUnit: string | undefined;
    try {
      const summary = JSON.parse(
        fs.readFileSync(path.join(dir, "summary.json"), "utf8"),
      ) as Json;
      if (typeof summary.resetUnit === "string") resetUnit = summary.resetUnit;
    } catch {
      // no summary yet (live), or unreadable: fall through to the events header
    }
    if (resetUnit === undefined) {
      try {
        const fd = fs.openSync(path.join(dir, "events.jsonl"), "r");
        try {
          const buf = Buffer.alloc(64 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const m = /"resetUnit":"([a-z]+)"/.exec(buf.subarray(0, n).toString("utf8"));
          if (m) resetUnit = m[1];
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // no events file either
      }
    }
    return resetUnit === "continuous"
      ? { kind: "past", currentBlock: currentBlockOf(file) }
      : { kind: "none" };
  }

  function acceptsGzip(req: IncomingMessage): boolean {
    const accept = req.headers["accept-encoding"];
    const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
    return /\bgzip\b/.test(value);
  }

  /** Send a body (string or stream) with content type, cache policy and gzip when the client takes it. */
  function send(
    req: IncomingMessage,
    res: ServerResponse,
    body: string | NodeJS.ReadableStream,
    contentType: string,
    cacheControl: string,
  ): void {
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", cacheControl);
    res.setHeader("vary", "accept-encoding");
    const small = typeof body === "string" && body.length < 1024;
    if (!small && acceptsGzip(req)) {
      res.setHeader("content-encoding", "gzip");
      const gz = createGzip();
      gz.pipe(res);
      if (typeof body === "string") gz.end(body);
      else body.pipe(gz);
      return;
    }
    if (typeof body === "string") res.end(body);
    else body.pipe(res);
  }

  /** events.jsonl for the audience: the file, line by line, through the redaction. */
  function redactedEventsStream(file: string): NodeJS.ReadableStream {
    const policy = schedulePolicyOf(file);
    let carry = "";
    const transform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        const text = carry + chunk.toString("utf8");
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        const out: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const kept = redactEventLine(line, policy);
          if (kept !== null) out.push(kept);
        }
        cb(null, out.length > 0 ? `${out.join("\n")}\n` : "");
      },
      flush(cb) {
        if (carry.trim()) {
          const kept = redactEventLine(carry, policy);
          cb(null, kept !== null ? `${kept}\n` : "");
        } else cb(null, "");
      },
    });
    return fs.createReadStream(file).pipe(transform);
  }

  /**
   * Handle a request whose path is relative to the /runs mount ("/index.json", "/<id>/summary.json").
   * Returns false when nothing here matched, so the caller can fall through to its own 404.
   */
  return function handle(
    urlPath: string,
    query: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (urlPath === "/index.json") {
      send(req, res, JSON.stringify(index()), "application/json", CACHE_SHORT);
      return true;
    }
    if (urlPath === "/mode.json") {
      send(
        req,
        res,
        JSON.stringify(mode),
        "application/json",
        "public, max-age=30",
      );
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
      if (
        !file ||
        !/\.(jsonl|csv)$/.test(file) ||
        (mode.audience && !audienceAllows(rel))
      ) {
        res.statusCode = mode.audience ? 404 : 403;
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
      const redactEvents =
        mode.audience && path.basename(file) === "events.jsonl";
      fs.stat(file, (err, stat) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", CACHE_NONE);
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
            const raw = Buffer.concat(chunks);
            if (!redactEvents) {
              res.end(
                JSON.stringify({ offset: end + 1, text: raw.toString("utf8") }),
              );
              return;
            }
            // Whole lines only: a line cut mid-way cannot be inspected, and half of a schedule is
            // still a schedule. The client polls again from the returned offset.
            const cut = raw.lastIndexOf(0x0a);
            if (cut < 0) {
              res.end(JSON.stringify({ offset: start, text: "" }));
              return;
            }
            const policy = schedulePolicyOf(file);
            const kept: string[] = [];
            for (const line of raw
              .subarray(0, cut)
              .toString("utf8")
              .split("\n")) {
              if (!line.trim()) continue;
              const out = redactEventLine(line, policy);
              if (out !== null) kept.push(out);
            }
            res.end(
              JSON.stringify({
                offset: start + cut + 1,
                text: kept.length > 0 ? `${kept.join("\n")}\n` : "",
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
    if (mode.audience && !audienceAllows(rel)) {
      // 404, not 403: for the audience an unpublished file does not exist, and a different status
      // for "exists but withheld" would confirm what is there to withhold.
      res.statusCode = 404;
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
    const contentType = file.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8";
    const cache = isFinishedRunFile(file) ? CACHE_IMMUTABLE : CACHE_SHORT;
    const base = path.basename(file);

    if (mode.audience && base === "events.jsonl") {
      send(req, res, redactedEventsStream(file), contentType, cache);
      return true;
    }
    if (mode.audience && REDACTED_JSON[base]) {
      fs.readFile(file, "utf8", (err, text) => {
        if (err) {
          res.statusCode = 500;
          res.end();
          return;
        }
        let out = text;
        try {
          out = `${JSON.stringify(REDACTED_JSON[base](JSON.parse(text) as Json), null, 2)}\n`;
        } catch {
          // Not JSON after all (a half-written file): serve nothing rather than the raw text.
          res.statusCode = 503;
          res.end();
          return;
        }
        send(req, res, out, contentType, cache);
      });
      return true;
    }
    send(req, res, fs.createReadStream(file), contentType, cache);
    return true;
  };
}
