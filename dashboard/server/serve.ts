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
import { createServer, request as httpRequest } from "node:http";
import { existsSync, createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunsApi } from "./runsApi.js";

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

const handleRuns = createRunsApi(RUNS);

// Resolve a request path inside dist/, or null. Same realpath discipline as the runs API: a symlink
// under dist/ must not become a way to read the rest of the disk.
function distFile(urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.replace(/^\//, "")) || "index.html";
  const resolved = path.resolve(DIST, rel);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) return null;
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const [urlPath, query] = (req.url ?? "/").split("?");

  if (urlPath.startsWith("/runs")) {
    const rest = urlPath.slice("/runs".length) || "/";
    if (handleRuns(rest, query, req, res)) return;
    res.statusCode = 404;
    res.end();
    return;
  }

  if (urlPath.startsWith("/blockscout")) {
    const target = new URL(
      urlPath.slice("/blockscout".length) + (query ? `?${query}` : ""),
      BLOCKSCOUT,
    );
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
  createReadStream(target).pipe(res);
});

server.listen(PORT, () => {
  console.error(
    `[dashboard] serving ${DIST} on http://localhost:${PORT}\n` +
      `[dashboard]   runs:       ${RUNS}\n` +
      `[dashboard]   blockscout: ${BLOCKSCOUT} (optional)`,
  );
});
