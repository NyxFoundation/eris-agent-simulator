#!/usr/bin/env node
// infra/devnet/block-gaps.mjs -- does the chain keep its cadence, and do its stalls grow?
//
//   node infra/devnet/block-gaps.mjs --rpc http://127.0.0.1:8545 --from 12000 [--to latest]
//        [--window 300] [--target 2] [--max-growth 1] [--headers '{"X-ASCON-Key":"…"}'] [--json]
//
// The exporter's ascon_block_interval_seconds is the newest block's interval, sampled every 10 s, so
// a stall of a few seconds at a state dump usually falls between two samples and is never seen. This
// reads every block's timestamp in the range (anvil keeps a header for every block, whatever
// --prune-history says) and decides the two things the acceptance check (CHECKLIST.md) asks of the
// chain:
//
//   mean     the average interval, within ±5% of the cadence. The period's length (run.endsAt) and
//            every evaluation interval are converted to blocks at that cadence, so a chain that runs
//            slow ends late and makes every "30-minute" interval longer than 30 minutes.
//   growth   the least-squares slope of each window's longest gap, times the range's duration. anvil
//            stops mining while it writes a dump (--state-interval 300); with its history unbounded
//            that stop grew from 9 s to 18 s in two hours (issue #135). Bounded, it must not grow.
//            The longest gap itself is reported but not judged: nothing measured it yet at the
//            bounds the compose file sets.
//
// Exit 0 when both pass, 1 when either fails, 2 when the range could not be read. No dependencies.

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const rpc = flag("rpc", process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545");
const windowSec = Number(flag("window", 300));
const target = Number(flag("target", 2));
const maxGrowth = Number(flag("max-growth", 1));
const asJson = flag("json", false) === true;
const headers = { "content-type": "application/json" };
if (flag("headers", undefined)) Object.assign(headers, JSON.parse(flag("headers")));

const BATCH = 250;

async function call(body) {
  const res = await fetch(rpc, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${rpc}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function latest() {
  const r = await call({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  if (r.error) throw new Error(`eth_blockNumber: ${r.error.message}`);
  return Number(BigInt(r.result));
}

/** block number -> unix timestamp, or null for a block the node did not return. */
async function timestamps(from, to) {
  const out = new Map();
  for (let start = from; start <= to; start += BATCH) {
    const end = Math.min(to, start + BATCH - 1);
    const batch = [];
    for (let n = start; n <= end; n++)
      batch.push({
        jsonrpc: "2.0",
        id: n,
        method: "eth_getBlockByNumber",
        params: [`0x${n.toString(16)}`, false],
      });
    const replies = await call(batch);
    for (const r of Array.isArray(replies) ? replies : [replies])
      out.set(Number(r.id), r.result ? Number(BigInt(r.result.timestamp)) : null);
  }
  return out;
}

function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

async function main() {
  const head = await latest();
  const toArg = flag("to", "latest");
  const to = toArg === "latest" ? head : Number(toArg);
  const from = Number(flag("from", Math.max(0, to - 1800)));
  if (!(to > from)) throw new Error(`empty range ${from}..${to}`);

  const ts = await timestamps(from, to);
  const missing = [...ts.entries()].filter(([, t]) => t === null).map(([n]) => n);
  const present = [...ts.entries()].filter(([, t]) => t !== null).sort((a, b) => a[0] - b[0]);
  if (present.length < 2) throw new Error("fewer than two blocks with a timestamp");

  const t0 = present[0][1];
  const gaps = []; // { block, gap, at }
  for (let i = 1; i < present.length; i++) {
    const [n, t] = present[i];
    const [pn, pt] = present[i - 1];
    if (n !== pn + 1) continue; // a missing block between them: no single interval to measure
    gaps.push({ block: n, gap: t - pt, at: t - t0 });
  }

  const span = present[present.length - 1][1] - t0;
  const blocks = present[present.length - 1][0] - present[0][0];
  const mean = span / blocks;

  const perWindow = new Map();
  for (const g of gaps) {
    const w = Math.floor(g.at / windowSec);
    perWindow.set(w, Math.max(perWindow.get(w) ?? 0, g.gap));
  }
  const windows = [...perWindow.entries()].sort((a, b) => a[0] - b[0]);
  const hours = windows.map(([w]) => (w * windowSec) / 3600);
  const maxima = windows.map(([, m]) => m);
  const growth = slope(hours, maxima) * (span / 3600);

  const hourly = new Map();
  for (const g of gaps) {
    const h = Math.floor(g.at / 3600);
    const cur = hourly.get(h) ?? { blocks: 0, sum: 0, max: 0 };
    cur.blocks += 1;
    cur.sum += g.gap;
    cur.max = Math.max(cur.max, g.gap);
    hourly.set(h, cur);
  }
  const longest = [...gaps].sort((a, b) => b.gap - a.gap).slice(0, 5);

  const meanOk = Math.abs(mean - target) <= 0.05 * target;
  const growthOk = growth < maxGrowth;
  const summary = {
    rpc,
    from,
    to,
    blocks,
    hours: +(span / 3600).toFixed(2),
    missingBlocks: missing.length,
    meanIntervalSec: +mean.toFixed(4),
    target,
    meanPass: meanOk,
    windowSec,
    longestGapSec: longest[0]?.gap ?? 0,
    growthSecOverRange: +growth.toFixed(3),
    maxGrowthSec: maxGrowth,
    growthPass: growthOk,
    longest: longest.map((g) => ({ block: g.block, gapSec: g.gap })),
    hourly: [...hourly.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, v]) => ({ hour: h, blocks: v.blocks, meanSec: +(v.sum / v.blocks).toFixed(3), maxSec: v.max })),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`blocks ${from}..${to} (${blocks} intervals, ${summary.hours} h) via ${rpc}`);
    if (missing.length > 0)
      console.log(`  ${missing.length} block(s) returned no header — first: ${missing.slice(0, 5).join(", ")}`);
    console.log("  hour  blocks  mean(s)  max(s)");
    for (const r of summary.hourly)
      console.log(`  ${String(r.hour).padStart(4)}  ${String(r.blocks).padStart(6)}  ${r.meanSec.toFixed(3).padStart(7)}  ${String(r.maxSec).padStart(6)}`);
    console.log(`  longest gaps: ${summary.longest.map((g) => `${g.gapSec}s @${g.block}`).join(", ")}`);
    console.log(`mean interval   ${mean.toFixed(4)} s (target ${target} s ±5%)      ${meanOk ? "PASS" : "FAIL"}`);
    console.log(`stall growth    ${growth.toFixed(3)} s over the range (max ${maxGrowth} s)  ${growthOk ? "PASS" : "FAIL"}`);
  }
  process.exit(meanOk && growthOk ? 0 : 1);
}

main().catch((e) => {
  console.error(`block-gaps: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
