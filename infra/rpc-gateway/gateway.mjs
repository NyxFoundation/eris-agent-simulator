// ASCON RPC gateway — a thin JSON-RPC-aware reverse proxy in front of anvil.
//
// anvil exposes no per-method metrics (every call is POST /), so we sit in front of it, read each
// request's `method`, time the upstream round-trip, and export:
//   - rpc_requests_total{env,method,status}          how often each endpoint is called
//   - rpc_request_duration_seconds{env,method}       latency histogram -> p50/p95/p99 per method
//   - rpc_batch_size{env}                             JSON-RPC batch sizes
//   - rpc_in_flight{env}                             concurrent upstream requests
//   - rpc_upstream_up{env}                           1 if the last upstream call connected
// plus one JSON line per call (method, dur_ms, status, client) for a Loki "who called what when" view.
//
// Env: PORT (8546) UPSTREAM (http://127.0.0.1:8545) ENV_NAME (live) LOG_FILE (append; else stdout)
import http from "node:http";
import { createWriteStream, writeFileSync, renameSync } from "node:fs";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8546);
const UPSTREAM = new URL(process.env.UPSTREAM || "http://127.0.0.1:8545");
const ENV_NAME = process.env.ENV_NAME || "live";
const LOG_FILE = process.env.LOG_FILE || "";
// The host firewall blocks the Prometheus bridge from scraping this host-networked process (same
// reason eris-exporter can't be scraped directly), so when METRICS_FILE is set we also dump the
// exposition to the shared textfile dir that node-exporter serves. HTTP /metrics still works locally.
const METRICS_FILE = process.env.METRICS_FILE || "";
const logStream = LOG_FILE ? createWriteStream(LOG_FILE, { flags: "a" }) : null;
const logline = (o) => { const s = JSON.stringify(o) + "\n"; logStream ? logStream.write(s) : process.stdout.write(s); };

const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const MAX_METHODS = 200;                                  // cardinality guard (rpc methods are bounded)

// metrics state, keyed by "method|status" (counter) and "method" (histogram)
const reqTotal = new Map();                               // key -> count
const hist = new Map();                                   // method -> {buckets:[], sum, count}
let batchSum = 0, batchCount = 0;
const batchB = new Map();                                 // le -> count  (batch size histogram)
const BATCH_BUCKETS = [1, 2, 5, 10, 20, 50, 100];
let inFlight = 0, upstreamUp = 1;

const methodLabel = (m) => (hist.size >= MAX_METHODS && !hist.has(m)) ? "_other" : (m || "_unknown");
// rpc_requests_total counts every JSON-RPC *call* (a batch expands to its members); the duration
// histogram is per HTTP *request* (labeled by the single method, or "_batch"). Two different denominators
// on purpose — so observe() only touches the histogram, never the request counter.
function observe(method, status, dur) {
  let h = hist.get(method);
  if (!h) { h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; hist.set(method, h); }
  h.sum += dur; h.count++;
  for (let i = 0; i < BUCKETS.length; i++) if (dur <= BUCKETS[i]) h.buckets[i]++;
}
function observeBatch(n) {
  batchSum += n; batchCount++;
  for (const le of BATCH_BUCKETS) if (n <= le) batchB.set(le, (batchB.get(le) || 0) + 1);
}

function metricsText() {
  const L = `env="${ENV_NAME}"`;
  let o = "";
  o += `# TYPE rpc_requests_total counter\n`;
  for (const [k, v] of reqTotal) { const [m, s] = k.split("|"); o += `rpc_requests_total{${L},method="${m}",status="${s}"} ${v}\n`; }
  o += `# TYPE rpc_request_duration_seconds histogram\n`;
  for (const [m, h] of hist) {
    // h.buckets[i] is already cumulative (observe() bumps every bucket the sample is <=)
    for (let i = 0; i < BUCKETS.length; i++) o += `rpc_request_duration_seconds_bucket{${L},method="${m}",le="${BUCKETS[i]}"} ${h.buckets[i]}\n`;
    o += `rpc_request_duration_seconds_bucket{${L},method="${m}",le="+Inf"} ${h.count}\n`;
    o += `rpc_request_duration_seconds_sum{${L},method="${m}"} ${h.sum}\n`;
    o += `rpc_request_duration_seconds_count{${L},method="${m}"} ${h.count}\n`;
  }
  o += `# TYPE rpc_batch_size histogram\n`;
  for (const le of BATCH_BUCKETS) o += `rpc_batch_size_bucket{${L},le="${le}"} ${batchB.get(le) || 0}\n`;
  o += `rpc_batch_size_bucket{${L},le="+Inf"} ${batchCount}\n`;
  o += `rpc_batch_size_sum{${L}} ${batchSum}\n`;
  o += `rpc_batch_size_count{${L}} ${batchCount}\n`;
  o += `# TYPE rpc_in_flight gauge\nrpc_in_flight{${L}} ${inFlight}\n`;
  o += `# TYPE rpc_upstream_up gauge\nrpc_upstream_up{${L}} ${upstreamUp}\n`;
  return o;
}

function clientFromReq(req) {
  const jwt = req.headers["cf-access-jwt-assertion"];
  if (jwt) {
    try {
      const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
      // service tokens -> common_name; identity -> email/sub
      return p.common_name || p.email || p.sub || "";
    } catch { /* fall through */ }
  }
  return req.headers["cf-access-client-id"] || "";
}

function forward(bodyBuf, cb) {
  const opts = { hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: UPSTREAM.pathname || "/",
    method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyBuf) } };
  const t0 = process.hrtime.bigint();
  const ur = http.request(opts, (r) => {
    const chunks = [];
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => { const dur = Number(process.hrtime.bigint() - t0) / 1e9; upstreamUp = 1; cb(null, r.statusCode, Buffer.concat(chunks), dur); });
  });
  ur.on("error", (e) => { const dur = Number(process.hrtime.bigint() - t0) / 1e9; upstreamUp = 0; cb(e, 502, Buffer.from(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "upstream: " + e.message } })), dur); });
  ur.end(bodyBuf);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/metrics") { res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }); return res.end(metricsText()); }
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) { res.writeHead(200); return res.end("ok\n"); }
  if (req.method !== "POST") { res.writeHead(405); return res.end("method not allowed\n"); }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    let parsed, isBatch = false, methods = [];
    try { parsed = JSON.parse(bodyBuf.toString("utf8")); } catch { parsed = null; }
    if (Array.isArray(parsed)) { isBatch = true; methods = parsed.map((x) => x && x.method).filter(Boolean); observeBatch(parsed.length); }
    else if (parsed && parsed.method) { methods = [parsed.method]; }
    const label = isBatch ? "_batch" : methodLabel(methods[0]);
    // Cloudflare Access consumes CF-Access-Client-Id for auth and does not forward it; it passes the
    // verified identity in the Cf-Access-Jwt-Assertion JWT. We only read it for logging (Access already
    // verified the signature), so a plain base64url decode of the payload is enough.
    const client = clientFromReq(req);
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "";

    inFlight++;
    forward(bodyBuf, (err, status, upBody, dur) => {
      inFlight--;
      let st = "ok";
      if (err || status >= 500) st = "upstream_error";
      else { try { const j = JSON.parse(upBody.toString("utf8")); if (Array.isArray(j) ? j.some((x) => x && x.error) : (j && j.error)) st = "rpc_error"; } catch { st = "bad_response"; } }
      // count each sub-method (so per-method rate is right); time by the request-level label
      const counted = methods.length ? methods.map(methodLabel) : [label];   // malformed -> _unknown
      for (const m of counted) reqTotal.set(`${m}|${st}`, (reqTotal.get(`${m}|${st}`) || 0) + 1);
      observe(label, st, dur);
      logline({ ts: new Date().toISOString(), env: ENV_NAME, method: label, methods: methods.length > 1 ? methods : undefined, batch: isBatch ? methods.length : undefined, dur_ms: +(dur * 1000).toFixed(1), status: st, http: status, client, ip });
      res.writeHead(err ? 502 : status, { "content-type": "application/json" });
      res.end(upBody);
    });
  });
});

server.listen(PORT, () => process.stdout.write(`rpc-gateway env=${ENV_NAME} :${PORT} -> ${UPSTREAM.href}${METRICS_FILE ? " textfile=" + METRICS_FILE : ""}\n`));

if (METRICS_FILE) setInterval(() => {
  try { writeFileSync(METRICS_FILE + ".tmp", metricsText()); renameSync(METRICS_FILE + ".tmp", METRICS_FILE); }
  catch (e) { process.stderr.write("textfile write error: " + e.message + "\n"); }
}, 10000);
