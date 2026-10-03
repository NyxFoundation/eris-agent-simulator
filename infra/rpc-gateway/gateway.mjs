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
//      RPC_KEYS_FILE (per-participant keys; setting it makes X-ASCON-Key mandatory)
//      RPC_MAX_TX_GAS (10000000) RPC_MAX_PRIORITY_FEE_WEI (5000000000; 0 disables the fee cap only)
//      RPC_MAX_BODY_BYTES (4194304) largest request body accepted; over it is 413 and the socket closes
import http from "node:http";
import { createWriteStream, writeFileSync, renameSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";

import { feeRuleViolation, txFees, txGasLimit } from "./txGas.mjs";

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

// ---- per-participant keys (the identity this gateway rate-limits and attributes on) ----
//
// Cloudflare Access service tokens were that identity, and they cap at 50 per account -- measured,
// not read: with 50 in existence the 51st create fails `org_has_exceeded_allowed_token_count`, and
// revoking one frees a slot immediately (so it is a concurrent-count cap, not a rate limit). A
// competition expecting more than 50 participants cannot be gated by them.
//
// So the credential is issued here instead. RPC_KEYS_FILE names a JSON file of
// `{"keys": {"<sha256 of the key, hex>": "<participant id>"}}`; a request carries the key in
// `X-ASCON-Key`, and the id it maps to becomes `client` -- the same string the bucket and the log
// line already key on, so nothing downstream changes.
//
// Setting the file turns enforcement ON. There is no separate flag, because a flag is a thing to
// forget: if keys are configured, a request without a valid one is 403, full stop. The `|| ip`
// fallback further down is unreachable in that mode by construction, which is the point -- an
// unknown key must not quietly become an IP-keyed bucket with access to the chain.
//
// The file is re-read when its mtime changes, so revoking is a file edit, not a restart.
const KEYS_FILE = process.env.RPC_KEYS_FILE || "";
let keyMap = new Map();          // sha256(key) hex -> participant id
let keysMtime = 0;
let keyDenied = 0;

function loadKeys(reason) {
  if (!KEYS_FILE) return;
  try {
    const st = statSync(KEYS_FILE);
    if (st.mtimeMs === keysMtime) return;
    const doc = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    const next = new Map(Object.entries(doc.keys || {}));
    keysMtime = st.mtimeMs;
    keyMap = next;
    logline({ ts: new Date().toISOString(), env: ENV_NAME, status: "keys_loaded", count: keyMap.size, reason });
  } catch (e) {
    // Keep serving with the keys already in memory. A truncated write (an operator mid-edit) must
    // not lock every participant out; a genuinely broken file surfaces as this line repeating.
    logline({ ts: new Date().toISOString(), env: ENV_NAME, status: "keys_load_failed", error: String(e && e.message).slice(0, 200) });
  }
}
loadKeys("startup");
if (KEYS_FILE) setInterval(() => loadKeys("reload"), 15_000).unref();

/** The participant id a key maps to, or null. Never returns, logs or compares the key itself. */
function idForKey(key) {
  if (typeof key !== "string" || key.length < 16 || key.length > 256) return null;
  return keyMap.get(createHash("sha256").update(key).digest("hex")) ?? null;
}

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
// The default is an explicit list, not a namespace prefix: a prefix passes every method the node
// adds under eth_ later, and anvil already has eth_ methods that act without a signature (it
// accepts eth_sendUnsignedTransaction from any `from`, unlocked or not). A method participants
// need and this list lacks is refused, which shows up as a 403 the first time; one it should not
// have passed shows up as nothing. RPC_METHOD_ALLOW (a regex) still replaces the list.
const ALLOWED_METHODS = new Set([
  "web3_clientVersion", "net_version", "net_listening",
  "eth_chainId", "eth_blockNumber", "eth_syncing", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_blobBaseFee",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_getProof",
  "eth_call", "eth_estimateGas", "eth_createAccessList",
  "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByHash", "eth_getRawTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionByBlockHashAndIndex",
  "eth_getRawTransactionByBlockNumberAndIndex", "eth_getRawTransactionByBlockHashAndIndex",
  "eth_getTransactionReceipt", "eth_getBlockReceipts",
  "eth_getLogs", "eth_newFilter", "eth_newBlockFilter", "eth_uninstallFilter",
  "eth_sendRawTransaction",
]);
const METHOD_ALLOW = process.env.RPC_METHOD_ALLOW
  ? new RegExp(process.env.RPC_METHOD_ALLOW)
  : { test: (m) => ALLOWED_METHODS.has(m) };
// Deny-list checked even for eth_* (allow-list is namespace-level, this is method-level): block the
// methods that ride on the node's own/unlocked accounts. anvil boots deterministic prefunded UNLOCKED
// accounts, so eth_sendTransaction/eth_accounts/eth_sign* would let a caller move funds without signing.
// Participants must sign locally and use eth_sendRawTransaction. Set RPC_METHOD_DENY to override.
const METHOD_DENY = new RegExp(process.env.RPC_METHOD_DENY ?? "^(eth_accounts|eth_sendTransaction|eth_sign|eth_pendingTransactions$|eth_newPendingTransactionFilter$|eth_getFilterChanges$|eth_getFilterLogs$|eth_subscribe$)");
// The `pending` tag is a view of the pool wherever it appears, not only in block enumeration:
// anvil executes eth_call / eth_getBalance / eth_getStorageAt ... at "pending" against a block built
// from the pool, so a state read there shows unmined transactions (the oracle update included). The
// one exception is eth_getTransactionCount(address, "pending"), which the sender needs to allocate a
// nonce after earlier submissions. The tag is matched in any position and inside objects (eth_getLogs
// / eth_newFilter take it as fromBlock/toBlock), case-insensitively.
const PENDING_TAG_EXEMPT = new Set(["eth_getTransactionCount"]);
// The walk is iterative and bounded. It used to recurse, and ~6,000 nested arrays (a 12KB body) ran
// the stack out inside req.on("end"), where nothing caught it: one authenticated request killed the
// gateway every participant shares. No standard method nests deeper than a handful of levels
// (eth_getLogs topics, eth_call state overrides), so a body past either limit is refused rather than
// inspected -- fail closed, like the gas cap: a check that gives up must not forward what it skipped.
const MAX_PARAM_DEPTH = Number(process.env.RPC_MAX_PARAM_DEPTH ?? "64");
const MAX_PARAM_NODES = Number(process.env.RPC_MAX_PARAM_NODES ?? "100000");
// true when `match` accepts some string in v, false when none does, null when v exceeds the limits.
function someString(v, match) {
  const stack = [v, 0];
  let nodes = 0;
  while (stack.length) {
    const depth = stack.pop();
    const x = stack.pop();
    if (++nodes > MAX_PARAM_NODES || depth > MAX_PARAM_DEPTH) return null;
    if (typeof x === "string") { if (match(x)) return true; continue; }
    if (x && typeof x === "object") for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push(c, depth + 1);
  }
  return false;
}
const isPending = (s) => s.toLowerCase() === "pending";
// A block parameter left out is not "latest" everywhere. anvil runs eth_estimateGas without one
// against the pending block (measured, anvil 1.5.1 / --no-mining: a reverting contract deployed in
// the pool made `eth_estimateGas [{to}]` revert while `[{to}, "latest"]` returned 0x5208), so the
// string check above never sees the tag and gas use or a conditional revert reads the pool. viem's
// estimateGas sends exactly that form. eth_call and eth_createAccessList default to latest, measured
// the same way. The gateway writes the tag in rather than refusing the call, because refusing would
// break every client's default; the reference runtime no longer relies on pending estimation
// (example/agents/runtime/send.ts, dependent legs).
const BLOCK_PARAM_INDEX = { eth_estimateGas: 1 };
function defaultBlockTag(c) {
  const i = BLOCK_PARAM_INDEX[c?.method];
  if (i === undefined || !Array.isArray(c.params) || c.params.length < i) return false;
  if (c.params[i] !== undefined && c.params[i] !== null) return false;
  c.params[i] = "latest";
  return true;
}
// Every method that submits a signed transaction. The gas cap and the fee rule read all of them, so a
// variant admitted later (or through RPC_METHOD_ALLOW) cannot skip both checks.
const RAW_SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);
const FILTER_METHODS = (process.env.RPC_FILTER ?? "1") !== "0";
let methodDenied = 0;
let paramsDenied = 0;   // bodies past MAX_PARAM_DEPTH / MAX_PARAM_NODES
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
const MAX_TX_GAS = BigInt(process.env.RPC_MAX_TX_GAS ?? "10000000");   // 0 disables. Same number as SimConfig.maxTxGas / ERIS_MAX_TX_GAS
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
    if (!c || !RAW_SEND_METHODS.has(c.method)) continue;
    const raw = Array.isArray(c.params) ? c.params[0] : undefined;
    if (typeof raw !== "string") return "unreadable";
    const gas = txGasLimit(raw);
    if (gas === null) return "unreadable";
    if (gas > MAX_TX_GAS) return gas;
  }
  return null;
}

// ---- fee rule: the field the block is ordered by must be the price paid ----
// anvil `--order fees` sorts the pool on maxFeePerGas (foundry v1.7.1: TransactionPriority(
// tx.max_fee_per_gas())), and with base fee 0 a transaction pays min(maxFeePerGas, tip). So a
// self-signed transaction with a high maxFeePerGas and a small tip is placed ahead of bids that pay
// more -- measured 2026-09-27 ahead of the environment's own oracle update (6 gwei), paying 0.1
// gwei/gas. Rules §2.6 order a block by the priority fee, so the gateway refuses what would make
// the order and the payment disagree (txGas.mjs feeRuleViolation):
//   typed (0x02/0x03/0x04):  maxFeePerGas <= maxPriorityFeePerGas <= RPC_MAX_PRIORITY_FEE_WEI
//   0x01 / legacy:           gasPrice <= RPC_MAX_PRIORITY_FEE_WEI
// RPC_MAX_PRIORITY_FEE_WEI is the same number as `fees.maxPriorityFeeWei` (5 gwei); 0 disables the
// cap half for the economic gas profile (ADR 0011 §2). The maxFeePerGas half has no switch: there
// is no configuration in which paying less than the position bought is the intended auction.
// Like the gas cap, it fails closed on a fee field it cannot read, and the post-run check
// (core/src/postRunCheck.ts) stays the authority for a participant who sends straight to a node.
const MAX_PRIORITY_FEE = BigInt(process.env.RPC_MAX_PRIORITY_FEE_WEI ?? "5000000000");
let feeDenied = 0;

// ---- request body cap (issue #216 (3)) ----
// The body used to be accumulated without bound before JSON.parse: one authenticated connection could
// hold the gateway's memory with a stream it never finished. The largest honest bodies are a signed
// deployment (initcode is capped at 49,152 bytes by EIP-3860, ~100KB as hex) and the runtime's
// batched Multicall3 reads (hundreds of KB); 4MiB is ~40x those, and sits with MAX_PARAM_DEPTH /
// MAX_PARAM_NODES as a bound on what a request may be before anything parses it. Both the declared
// length and the bytes actually received are checked, because a client need not declare or tell the
// truth.
const MAX_BODY_BYTES = Number(process.env.RPC_MAX_BODY_BYTES ?? "4194304");
let bodyDenied = 0;

// ---- unmined transactions stay sealed when read by hash (issue #216 (3)) ----
// eth_getTransactionByHash / eth_getRawTransactionByHash stay on ALLOWED_METHODS: the receipt poll,
// explorers and replay tooling read mined transactions through them. But anvil answers them for pool
// entries too, so a hash learned some other way (a shared sender, a log line, a guessed nonce) showed
// an unmined transaction's calldata, fees and signed bytes -- the auction the pending ban seals. The
// gateway answers `null` for a transaction that has no block yet, the same reply as for a hash it
// never saw; a mined transaction passes through byte for byte. The raw form carries no block field,
// so it costs one upstream receipt lookup. Failure to look up seals (fail closed).
const TX_BY_HASH_METHODS = new Set(["eth_getTransactionByHash", "eth_getRawTransactionByHash"]);
let pendingSealed = 0;

// Rewrites the upstream reply for the tx-by-hash calls in `parsed`, then hands the body to `cb`.
// Untouched bodies are passed through as received, so nothing else is re-serialized.
function sealPending(parsed, upBody, cb) {
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const byId = new Map();
  for (const c of calls) if (c && TX_BY_HASH_METHODS.has(c.method)) byId.set(String(c.id), c);
  if (byId.size === 0) return cb(upBody);
  let reply;
  try { reply = JSON.parse(upBody.toString("utf8")); } catch { return cb(upBody); }
  const responses = Array.isArray(reply) ? reply : [reply];
  let changed = false;
  const lookups = [];
  for (const r of responses) {
    if (!r || r.result === null || r.result === undefined) continue;
    const c = byId.get(String(r.id));
    if (!c) continue;
    if (c.method === "eth_getTransactionByHash") {
      if (typeof r.result === "object" && r.result.blockNumber === null) { r.result = null; changed = true; pendingSealed++; }
      continue;
    }
    const hash = Array.isArray(c.params) ? c.params[0] : undefined;
    const probe = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_getTransactionReceipt", params: [hash] }));
    lookups.push(new Promise((resolve) => forward(probe, (err, status, body) => {
      let mined = false;
      if (!err && status < 400) { try { const j = JSON.parse(body.toString("utf8")); mined = j && j.result !== null && j.result !== undefined; } catch { /* sealed below */ } }
      if (!mined) { r.result = null; changed = true; pendingSealed++; }
      resolve();
    })));
  }
  const done = () => cb(changed ? Buffer.from(JSON.stringify(reply)) : upBody);
  lookups.length ? Promise.all(lookups).then(done) : done();
}

// The first submission in a request that breaks the fee rule: { kind, message }, or null.
function feeViolation(parsed) {
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of calls) {
    if (!c || !RAW_SEND_METHODS.has(c.method)) continue;
    const raw = Array.isArray(c.params) ? c.params[0] : undefined;
    const fees = typeof raw === "string" ? txFees(raw) : null;
    if (fees === null)
      return { kind: "unreadable", message: "could not read the transaction's fee fields; refusing it" };
    const v = feeRuleViolation(fees, MAX_PRIORITY_FEE);
    if (v) return v;
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
  o += `# TYPE rpc_fee_denied_total counter\nrpc_fee_denied_total{${L}} ${feeDenied}\n`;
  o += `# TYPE rpc_method_denied_total counter\nrpc_method_denied_total{${L}} ${methodDenied}\n`;
  o += `# TYPE rpc_params_denied_total counter\nrpc_params_denied_total{${L}} ${paramsDenied}\n`;
  o += `# TYPE rpc_body_denied_total counter\nrpc_body_denied_total{${L}} ${bodyDenied}\n`;
  o += `# TYPE rpc_pending_sealed_total counter\nrpc_pending_sealed_total{${L}} ${pendingSealed}\n`;
  o += `# TYPE rpc_key_denied_total counter\nrpc_key_denied_total{${L}} ${keyDenied}\n`;
  o += `# TYPE rpc_keys_loaded gauge\nrpc_keys_loaded{${L}} ${keyMap.size}\n`;
  return o;
}

function clientFromReq(req) {
  // The issued key wins where it is configured; Access is then only the outer gate and no longer
  // the thing that says *who* this is.
  if (KEYS_FILE) return idForKey(req.headers["x-ascon-key"]);
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

  // Body cap: refuse on the declared length before reading, and on the bytes received while reading
  // (a client need not declare, or declare truthfully). The reply is written before the socket is
  // closed so the client sees a 413 rather than a reset; the request is not read to its end.
  const refuseBody = (bytes) => {
    bodyDenied++;
    logline({ ts: new Date().toISOString(), env: ENV_NAME, status: "body_denied", bytes, limit: MAX_BODY_BYTES, ip: req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "" });
    res.writeHead(413, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request body exceeds ${MAX_BODY_BYTES} bytes` } }), () => req.destroy());
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuseBody(declared);
  const chunks = [];
  let received = 0, tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return refuseBody(received); }
    chunks.push(c);
  });
  // A client that resets mid-body emits "error" on the request; unhandled, that also ends the process.
  req.on("error", () => {});
  req.on("end", () => {
    if (tooLarge) return;
    // Nothing a request carries may end the process: an exception here used to propagate out of the
    // event handler uncaught, taking every in-flight request down with it.
    try { handle(req, res, chunks); }
    catch (e) {
      process.stderr.write("request handler error: " + (e && e.stack || e) + "\n");
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "gateway internal error" } })); }
      else res.destroy();
    }
  });
});

function handle(req, res, chunks) {
  let bodyBuf = Buffer.concat(chunks);
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

  // No valid key, no chain. Checked before the allowlist so an unauthenticated caller cannot use
  // the difference between "method not permitted" and "rate limited" to map the gateway.
  if (KEYS_FILE && !client) {
    keyDenied++;
    logline({ ts: new Date().toISOString(), env: ENV_NAME, method: label, status: "key_denied", ip });
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: isBatch ? null : (parsed?.id ?? null),
      error: { code: -32001, message: "missing or unknown X-ASCON-Key" } }));
  }

  // Bound the shape before any check walks it (see someString). Applies with RPC_FILTER=0 as well:
  // the limits are far above anything a standard method sends.
  if (parsed !== null && someString(parsed, () => false) === null) {
    paramsDenied++;
    logline({ ts: new Date().toISOString(), env: ENV_NAME, method: label, status: "params_denied", client, ip });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: `request nests deeper than ${MAX_PARAM_DEPTH} levels or has more than ${MAX_PARAM_NODES} values` } }));
  }

  // method allowlist (4.22): reject cheatcodes / privileged methods before anvil is touched
  if (FILTER_METHODS && methods.length) {
    const calls = isBatch ? parsed : [parsed];
    const bad = calls.find((c) => c && c.method && (
      !METHOD_ALLOW.test(c.method) || METHOD_DENY.test(c.method) ||
      (!PENDING_TAG_EXEMPT.has(c.method) && someString(c.params, isPending) !== false)
    ))?.method;
    if (bad) {
      methodDenied++;
      logline({ ts: new Date().toISOString(), env: ENV_NAME, method: bad, status: "method_denied", client, ip });
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: isBatch ? null : (parsed.id ?? null), error: { code: -32601, message: `method not permitted: ${bad}` } }));
    }
    // An omitted block parameter that the node would read as pending becomes "latest" (above).
    // Re-serialized only when something changed, so every other body is forwarded byte for byte.
    if (calls.map(defaultBlockTag).some(Boolean)) bodyBuf = Buffer.from(JSON.stringify(parsed));
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

  // fee rule -> refuse a transaction whose order key would exceed what it pays (or the cap)
  const badFee = feeViolation(parsed);
  if (badFee !== null) {
    feeDenied++;
    logline({ ts: new Date().toISOString(), env: ENV_NAME, method: "eth_sendRawTransaction", status: "fee_denied", kind: badFee.kind, cap: String(MAX_PRIORITY_FEE), client, ip });
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: isBatch ? null : (parsed?.id ?? null), error: { code: -32003, message: badFee.message } }));
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
  forward(bodyBuf, (err, status, rawBody, dur) => sealPending(parsed, rawBody, (upBody) => {
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
  }));
}

server.listen(PORT, () => process.stdout.write(`rpc-gateway env=${ENV_NAME} :${PORT} -> ${UPSTREAM.href}${METRICS_FILE ? " textfile=" + METRICS_FILE : ""}\n`));

if (METRICS_FILE) setInterval(() => {
  try { writeFileSync(METRICS_FILE + ".tmp", metricsText()); renameSync(METRICS_FILE + ".tmp", METRICS_FILE); }
  catch (e) { process.stderr.write("textfile write error: " + e.message + "\n"); }
}, 10000);
