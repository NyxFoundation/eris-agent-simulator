// External RPC load test — drives sustained JSON-RPC traffic at ascon-rpc.nyx.foundation through the
// FULL external path (Cloudflare edge -> Access -> tunnel -> rpc-gateway -> anvil), so it measures what
// a real team experiences AND lights up the Grafana "RPC & Chain" dashboard (rate / per-method latency /
// call timeline). This is the external counterpart to `npm run stress:rpc` (which hits the node directly).
//
//   node loadtest.mjs --concurrency 50 --seconds 120 [--url https://ascon-rpc.nyx.foundation]
//
// Auth: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (source cf-service-token.env first). Closed-loop:
// C workers, each fires the next call as soon as the previous returns, so throughput is whatever the
// path sustains at that concurrency. Read-only calls (no state mutation) — safe against a live chain.
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return a;
}, []));
const URL_ = args.url || "https://ascon-rpc.nyx.foundation";
const CONC = Math.max(1, Number(args.concurrency || 50));
const SECONDS = Math.max(1, Number(args.seconds || 120));
const TIMEOUT_MS = Number(args.timeout || 15000);
const ID = process.env.CF_ACCESS_CLIENT_ID || "";
const SECRET = process.env.CF_ACCESS_CLIENT_SECRET || "";
if (!ID || !SECRET) { console.error("set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (source cf-service-token.env)"); process.exit(1); }

// realistic read mix: mostly light calls, some heavier block/state reads
const MIX = [
  ["eth_blockNumber", [], 5],
  ["eth_chainId", [], 3],
  ["eth_gasPrice", [], 3],
  ["eth_getBalance", ["0x0000000000000000000000000000000000000000", "latest"], 3],
  ["eth_getBlockByNumber", ["latest", false], 2],
  ["eth_getBlockByNumber", ["latest", true], 1],   // heaviest: full block with txs
];
const WEIGHTED = MIX.flatMap(([m, p, w]) => Array.from({ length: w }, () => [m, p]));
const pick = (i) => WEIGHTED[i % WEIGHTED.length];   // deterministic rotation (no Math.random needed)

const headers = { "content-type": "application/json", "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET };
const lat = [];                     // all latencies (ms)
const perMethod = new Map();        // method -> {n, errs, lat:[]}
let ok = 0, err = 0, n = 0;
const t0 = Date.now();
const deadline = t0 + SECONDS * 1000;

async function one(seq) {
  const [method, params] = pick(seq);
  const body = JSON.stringify({ jsonrpc: "2.0", id: seq, method, params });
  const pm = perMethod.get(method) || { n: 0, errs: 0, lat: [] };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const s = performance.now();
  try {
    const r = await fetch(URL_, { method: "POST", headers, body, signal: ac.signal });
    const j = await r.json().catch(() => null);
    const dt = performance.now() - s;
    lat.push(dt); pm.lat.push(dt);
    if (r.status === 200 && j && !j.error) ok++; else { err++; pm.errs++; }
  } catch { err++; pm.errs++; lat.push(performance.now() - s); }
  finally { clearTimeout(to); }
  n++; pm.n++; perMethod.set(method, pm);
}

async function worker(id) {
  let seq = id;
  while (Date.now() < deadline) { await one(seq); seq += CONC; }
}

const q = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const fmt = (x) => x.toFixed(1);

// live progress every 10s
let last = 0, lastN = 0;
const timer = setInterval(() => {
  const el = (Date.now() - t0) / 1000;
  const window = lat.slice(lastN);
  console.log(`[${el.toFixed(0)}s] req=${n} ok=${ok} err=${err} rate=${fmt((n - lastN) / (el - last))}/s p95=${fmt(q(window, 0.95))}ms`);
  last = el; lastN = n;
}, 10000);

console.log(`load: ${URL_}  concurrency=${CONC}  ${SECONDS}s  mix=[${MIX.map((m) => m[0]).join(",")}]`);
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
clearInterval(timer);

const dur = (Date.now() - t0) / 1000;
console.log("\n=== RESULT ===");
console.log(`url            ${URL_}`);
console.log(`concurrency    ${CONC}`);
console.log(`duration       ${fmt(dur)}s`);
console.log(`requests       ${n}  (ok ${ok}, err ${err})`);
console.log(`throughput     ${fmt(n / dur)} req/s`);
console.log(`latency ms     p50 ${fmt(q(lat, 0.5))}  p95 ${fmt(q(lat, 0.95))}  p99 ${fmt(q(lat, 0.99))}  max ${fmt(Math.max(...lat))}`);
console.log("\nper-method     n        errs   p50ms   p95ms");
for (const [m, s] of [...perMethod].sort((a, b) => b[1].n - a[1].n))
  console.log(`  ${m.padEnd(24)} ${String(s.n).padStart(7)} ${String(s.errs).padStart(6)}  ${fmt(q(s.lat, 0.5)).padStart(6)}  ${fmt(q(s.lat, 0.95)).padStart(6)}`);
