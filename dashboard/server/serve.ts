// The hosted dashboard (ADR 0021 §5).
//
//   npm run dashboard:build && npm run dashboard:serve
//
// A practice period's artifacts are on the coordinator's machine and the participants are not, so
// the dashboard has to be served rather than run locally. This is that server: the built bundle, the
// same runs API the dev server mounts, and a pass-through to Blockscout so the explorer's deep links
// keep working from the same origin.
//
// Deliberately small. It serves files the operator already has and proxies one local service; it
// holds no state, takes no writes, and knows nothing about a run. Running the dashboard locally
// against local output (the existing way) is unchanged and stays the development path.
//
// It is read-only, but it is not an access-control boundary: everything under runs/ becomes public.
// That is the intent — a practice period's artifacts are what participants come to look at — but it
// is also why the environment manifest carries no keys (core/src/manifest.ts) and why nothing that
// should stay private is written into a run directory.
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  createReadStream,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { competitionsFromEnv, createRunsApi, modeFromEnv } from "./runsApi.js";
import { explorerTarget } from "./explorerProxy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST =
  process.env.ERIS_DASHBOARD_DIST ?? path.resolve(here, "..", "dist");
const RUNS =
  process.env.ERIS_RUNS_DIR ?? path.resolve(here, "..", "..", "runs");
const PORT = Number(process.env.PORT ?? 5174);
// Where the explorer lives, if one is running. The dashboard probes this same-origin and silently
// drops its deep links when it fails, so an operator without Blockscout needs to configure nothing.
const BLOCKSCOUT = process.env.ERIS_BLOCKSCOUT_URL ?? "http://localhost:3100";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error(
    `[dashboard] no build at ${DIST}. Run \`npm run dashboard:build\` first ` +
      "(this server serves a built bundle; `npm run dashboard` is the dev server).",
  );
  process.exit(1);
}

// Which commit is being served. infra/dashboard/sync-main.sh writes dist/.build-info.json on every
// build, inside the directory it describes so it cannot outlive it. Read per request: the sync swaps
// dist/ under a running server, and catching exactly that is the point.
type BuildInfo = { commit: string | null; builtAt: string | null };

function readBuildInfo(): BuildInfo {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(DIST, ".build-info.json"), "utf8"),
    ) as Record<string, unknown>;
    return { commit: str(parsed.commit), builtAt: str(parsed.builtAt) };
  } catch {
    // A dist from before this file existed, or one built by `npm run dashboard:build` with no sync
    // involved. .built-at holds the commit and nothing else; past that there is nothing to report,
    // and null says so where a guess would read as a fact.
    try {
      const at = readFileSync(path.join(DIST, ".built-at"), "utf8").trim();
      return { commit: str(at), builtAt: null };
    } catch {
      return { commit: null, builtAt: null };
    }
  }
}

// What this process started alongside. `tsx dashboard/server/serve.ts` compiles this file once, at
// startup, and the container is `restart: unless-stopped` -- so a build that lands afterwards
// replaces the bundle and leaves this code as it was. When the two commits below differ, a promotion
// has reached the box since the restart, and whatever it changed under dashboard/server/ (the runs
// API's redaction, the competition allowlist) is not live yet: `docker compose restart
// ascon-dashboard`. See infra/dashboard/README.md, "a deploy is a build".
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_COMMIT = readBuildInfo().commit;

// ERIS_DASHBOARD_AUDIENCE=1 for anyone who is not the operator (the trial period and the live
// week are both public, 2026-09-06); ERIS_DASHBOARD_STANDINGS=0 for the trial environment, which
// posts no standings (rules §4.7); ERIS_DASHBOARD_COMPETITIONS=<ids> to offer only those
// competitions (a hosted box keeps every smoke run the operator made). What each switch
// withholds is documented in runsApi.ts.
const MODE = modeFromEnv();
const COMPETITIONS = competitionsFromEnv();
const handleRuns = createRunsApi(RUNS, {
  ...MODE,
  ...(COMPETITIONS ? { competitions: COMPETITIONS } : {}),
});

// Resolve a request path inside dist/, or null. Same realpath discipline as the runs API: a symlink
// under dist/ must not become a way to read the rest of the disk.
function distFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.replace(/^\//, ""));
  } catch {
    // Not valid percent-encoding, so it names no file. It used to throw out of the handler and end
    // the process (issue #203).
    return null;
  }
  const rel = decoded || "index.html";
  const resolved = path.resolve(DIST, rel);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) return null;
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  // One request must not be able to end the process. Anything unexpected inside answers 500: the
  // hosted dashboard is public and unauthenticated, so a throw that escapes here is a denial of
  // service for every viewer (issue #203).
  try {
    handle(req, res);
  } catch (err) {
    console.error("[dashboard] request failed", err);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
});

function handle(req: IncomingMessage, res: ServerResponse): void {
  const [urlPath, query] = (req.url ?? "/").split("?");

  // What the exporter probes (issue #159), and what an outside check can. Not the SPA fallback: that
  // answers 200 with index.html for any path, so a probe of an arbitrary URL proved only that node
  // was running. This also proves the one thing every page needs, that runs/ can be listed.
  if (urlPath === "/healthz") {
    let ok = true;
    try {
      readdirSync(RUNS);
    } catch {
      ok = false;
    }
    const info = readBuildInfo();
    res.statusCode = ok ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    // `ok` keeps its meaning -- node is up and runs/ can be listed -- because
    // ascon_dashboard_down alerts on it, and a stale bundle is not an outage. The commits are
    // reported, not judged: builtSinceStart is the fact (a build landed under this process), and
    // whether that needs a restart depends on what the build changed.
    res.end(
      JSON.stringify({
        ok,
        commit: info.commit,
        builtAt: info.builtAt,
        serverStartedAt: SERVER_STARTED_AT,
        serverCommit: SERVER_COMMIT,
        builtSinceStart:
          info.commit !== null &&
          SERVER_COMMIT !== null &&
          info.commit !== SERVER_COMMIT,
      }),
    );
    return;
  }

  if (urlPath.startsWith("/runs")) {
    const rest = urlPath.slice("/runs".length) || "/";
    if (handleRuns(rest, query, req, res)) return;
    res.statusCode = 404;
    res.end();
    return;
  }

  if (urlPath.startsWith("/blockscout")) {
    const target = explorerTarget(
      urlPath.slice("/blockscout".length),
      query,
      req.method,
      BLOCKSCOUT,
    );
    if (!target) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const upstream = httpRequest(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    // The explorer being down is a normal state, not an error: the dashboard treats a failed probe
    // as "no explorer" and hides its deep links.
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
    return;
  }

  const file = distFile(urlPath);
  // SPA fallback: every dashboard route is client-side, so an unknown path is a route, not a 404.
  const target = file ?? path.join(DIST, "index.html");
  res.setHeader(
    "content-type",
    MIME[path.extname(target)] ?? "application/octet-stream",
  );
  // Vite names bundled assets by content hash, so they can be cached forever; index.html is the
  // one file whose content changes under a fixed name.
  res.setHeader(
    "cache-control",
    target.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );
  createReadStream(target).pipe(res);
}

server.listen(PORT, () => {
  console.error(
    `[dashboard] serving ${DIST} on http://localhost:${PORT}\n` +
      `[dashboard]   runs:       ${RUNS}\n` +
      `[dashboard]   blockscout: ${BLOCKSCOUT} (optional)\n` +
      `[dashboard]   bundle:     ${SERVER_COMMIT ?? "no dist/.build-info.json (built outside the sync)"}\n` +
      `[dashboard]   mode:       ${MODE.audience ? "audience (public view: scenarios, upcoming windows, decision logs and pending bids withheld)" : "operator (everything under runs/ is served)"}` +
      `${MODE.standings ? "" : ", standings not posted (rules §4.7)"}\n` +
      `[dashboard]   competitions: ${COMPETITIONS ? COMPETITIONS.join(", ") : "all under runs/ (set ERIS_DASHBOARD_COMPETITIONS to restrict)"}`,
  );
});
