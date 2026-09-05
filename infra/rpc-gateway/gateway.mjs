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

import { txGasLimit } from "./txGas.mjs";

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

// ---- per-client rate limit (anti-abuse C): token bucket, heavy methods cost more (simulateTx spam) ----
const RATE_REFILL = Number(process.env.RPC_RATE_REFILL ?? "100");   // tokens/sec/client (0 disables)
const RATE_BURST = Number(process.env.RPC_RATE_BURST ?? "300");     // bucket capacity
const HEAVY_WEIGHT = Number(process.env.RPC_HEAVY_WEIGHT ?? "5");   // cost of an EVM-executing read
const HEAVY = /^(eth_call|eth_estimateGas|eth_createAccessList|eth_getLogs|debug_|trace_|arbtrace_)/;
const weight = (m) => (m && HEAVY.test(m) ? HEAVY_WEIGHT : 1);

// ---- method allowlist (4.22: make the dev anvil cheatcode-free for callers via the gateway) ----
// Default-deny: only standard eth_/net_/web3_ pass. Blocks anvil_/evm_/hardhat_ (setBalance, mine,
// setStorageAt, impersonate, snapshot...), debug_/trace_ control+trace, txpool_ (mempool spying),
// miner_/admin_/personal_. The operator hits anvil directly (not the gateway) for setup, so its
// cheatcodes still work. Set RPC_FILTER=0 to disable (e.g. an internal all-access gateway).
const METHOD_ALLOW = new RegExp(process.env.RPC_METHOD_ALLOW ?? "^(eth_|net_|web3_)");
// Deny-list checked even for eth_* (allow-list is namespace-level, this is method-level): block the
// methods that ride on the node's own/unlocked accounts. anvil boots deterministic prefunded UNLOCKED
// accounts, so eth_sendTransaction/eth_accounts/eth_sign* would let a caller move funds without signing.
// Participants must sign locally and use eth_sendRawTransaction. Set RPC_METHOD_DENY to override.
const METHOD_DENY = new RegExp(process.env.RPC_METHOD_DENY ?? "^(eth_accounts|eth_sendTransaction|eth_sign)");
const FILTER_METHODS = (process.env.RPC_FILTER ?? "1") !== "0";
let methodDenied = 0;
// ---- per-tx gas cap (issue #40 T0) ----
// Rules §5 caps how MANY transactions an agent may put in a block, not how much gas each one burns.
// That is enough while every transaction is a swap; it stops being enough once agents deploy their
// own contracts, because one call into deliberately expensive code can eat the block gas limit and
// starve every other participant -- and the environment's own oracle update, which is what makes it
// an attack on the competition rather than a trade against a counterparty.
//
// The gas limit is a signed field of the transaction, so it can be read here without executing
// anything and without trusting the sender. Refusing up front is strictly better than detecting
// afterwards: by the time blocks.csv shows it, the block it starved is gone. The post-run check in
// core/src/postRunCheck.ts stays as the authority (a self-hosted participant can bypass a gateway).
const MAX_TX_GAS = BigInt(process.env.RPC_MAX_TX_GAS ?? "30000000");   // 0 disables. Same number as SimConfig.maxTxGas / ERIS_MAX_TX_GAS
let gasDenied = 0;

// The over-cap transaction in a request, if any. Returns its gas limit; null when everything is fine.
// Returns the offending gas limit, the string "unreadable" when a submission's gas could not be
// read, or null when everything is within the cap.
//
// Fail closed. A transaction whose gas limit this cannot read is refused rather than forwarded: a
// cap that passes what it does not understand is bypassed by using a transaction type it does not
// understand, and the post-run check only sees it after the block it starved is over.
function overCapGas(parsed) {
  if (MAX_TX_GAS <= 0n) return null;
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of calls) {
    if (!c || c.method !== "eth_sendRawTransaction") continue;
    const raw = Array.isArray(c.params) ? c.params[0] : undefined;
    if (typeof raw !== "string") return "unreadable";
    const gas = txGasLimit(raw);
    if (gas === null) return "unreadable";
    if (gas > MAX_TX_GAS) return gas;
  }
  return null;
}

const buckets = new Map();                                          // client -> {tokens, last}
let rateLimited = 0;
function allow(client, cost) {
  if (RATE_REFILL <= 0) return true;
  const now = Date.now();
  let b = buckets.get(client);
  if (!b) { b = { tokens: RATE_BURST, last: now }; buckets.set(client, b); }
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.last) / 1000) * RATE_REFILL);
  b.last = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost; return true;
}

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
  o += `# TYPE rpc_ratelimited_total counter\nrpc_ratelimited_total{${L}} ${rateLimited}\n`;
  o += `# TYPE rpc_gas_denied_total counter\nrpc_gas_denied_total{${L}} ${gasDenied}\n`;
  o += `# TYPE rpc_method_denied_total counter\nrpc_method_denied_total{${L}} ${methodDenied}\n`;
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

    // method allowlist (4.22): reject cheatcodes / privileged methods before anvil is touched
    if (FILTER_METHODS && methods.length) {
      const bad = methods.find((m) => !METHOD_ALLOW.test(m) || METHOD_DENY.test(m));
      if (bad) {
        methodDenied++;
        logline({ ts: new Date().toISOString(), env: ENV_NAME, method: bad, status: "method_denied", client, ip });
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: (!isBatch && parsed && parsed.id) || null, error: { code: -32601, message: `method not permitted: ${bad}` } }));
      }
    }

    // per-tx gas cap (issue #40 T0) -> refuse before the transaction can starve a block
    const overCap = overCapGas(parsed);
    if (overCap !== null) {
      gasDenied++;
      logline({ ts: new Date().toISOString(), env: ENV_NAME, method: "eth_sendRawTransaction", status: "gas_denied", gas: String(overCap), limit: String(MAX_TX_GAS), client, ip });
      const message = overCap === "unreadable"
        ? `could not read the transaction's gas limit; refusing it (the per-transaction cap is ${MAX_TX_GAS})`
        : `transaction gas limit ${overCap} exceeds the per-transaction cap ${MAX_TX_GAS}`;
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: (!isBatch && parsed && parsed.id) || null, error: { code: -32003, message } }));
    }

    // per-client rate limit (heavy EVM-executing reads cost more) -> 429 before touching anvil
    const cost = (methods.length ? methods : [label]).reduce((s, m) => s + weight(m), 0) || 1;
    if (!allow(client || ip || "anon", cost)) {
      rateLimited++;
      logline({ ts: new Date().toISOString(), env: ENV_NAME, method: label, status: "rate_limited", client, ip });
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: (!isBatch && parsed && parsed.id) || null, error: { code: -32005, message: "rate limited" } }));
    }

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
