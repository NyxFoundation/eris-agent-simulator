// Reads a backtest matrix directory and prints, per scenario, what the tokenLaunch event did and
// what the agents made of it. Usage: node scripts/analyzeLaunch.mjs runs/matrix-<id>
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2]);
const matrix = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8"));
const U = 1e6;
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US");

for (const sc of matrix.scenarios) {
  const runDir = sc.runDir && existsSync(sc.runDir) ? sc.runDir : join(dir, "..", sc.runDir ?? "");
  const evPath = join(runDir, "events.jsonl");
  console.log(`\n=== ${sc.regime}#${sc.seed} (s=${sc.s})  ${runDir}`);
  if (!existsSync(evPath)) { console.log("  no events.jsonl"); continue; }
  const events = readFileSync(evPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const started = events.find((e) => e.type === "run_started_realtime");
  const first = started?.firstBlock ?? started?.startBlock ?? null;
  const summaries = events.filter((e) => e.type === "stress_token_launch_summary");
  const launches = events.filter((e) => e.type === "stress_token_launch");
  const waves = events.filter((e) => e.type === "stress_token_launch_wave");
  const sells = events.filter((e) => e.type === "stress_token_launch_sellback");
  const bad = events.filter((e) => /stress_token_launch_(failed|stuck|reverted|task_failed|quote_failed)/.test(e.type));
  const sched = events.find((e) => e.type === "stress_schedule");
  const tl = sched?.events?.find?.((x) => x.type === "tokenLaunch") ?? sched?.resolved?.find?.((x) => x.type === "tokenLaunch");
  if (tl) console.log(`  window: ${JSON.stringify({ start: tl.startBlock ?? tl.start, end: tl.endBlock ?? tl.end, ramp: tl.rampBlocks, hold: tl.holdBlocks, decay: tl.decayBlocks })}`);
  for (const s of summaries) {
    const l = launches.find((x) => x.index === s.index);
    const w = waves.filter((x) => x.index === s.index);
    const sb = sells.filter((x) => x.index === s.index);
    const liq = Number(s.liquidityUsdc);
    const gross = Number(s.grossBuyUsdcUnits) / U;
    const recv = Number(s.sellUsdcReceivedUnits) / U;
    const maxStep = w.reduce((m, x) => Math.max(m, Number(x.amountIn) / U), 0);
    // Full-range V3 with equal sides: buying x of the USDC side lifts the price by ≈ (1+x)^2 − 1.
    const firstStep = w.length ? Number(w[0].amountIn) / U : 0;
    const stepPct = (x) => ((1 + x / liq) ** 2 - 1) * 100;
    console.log(
      `  ${s.symbol.padEnd(6)} pool ${fmt(liq)} USDC  listed@${s.listedAtBlock ?? "-"}${first != null && s.listedAtBlock ? ` (rel ${s.listedAtBlock - first})` : ""}  ` +
        (s.dud
          ? `DUD`
          : `wave target ${fmt(Number(s.waveUsdcUnits) / U)} (${fmt((Number(s.waveUsdcUnits) / U / liq) * 100)}% of side) buys ${w.length} gross ${fmt(gross)} | first step ${fmt(firstStep)} ≈ +${fmt(stepPct(firstStep))}% px, max step ${fmt(maxStep)} ≈ +${fmt(stepPct(maxStep))}% | sellbacks ${sb.length} recv ${fmt(recv)} | net paid ${fmt(gross - recv)}`),
    );
  }
  if (bad.length) {
    const byType = {};
    for (const b of bad) byType[b.type] = (byType[b.type] ?? 0) + 1;
    console.log(`  problems: ${JSON.stringify(byType)}`);
  }
  const netPaid = summaries.reduce((a, s) => a + (Number(s.grossBuyUsdcUnits) - Number(s.sellUsdcReceivedUnits)) / U, 0);
  const agents = (sc.agents ?? []).map((a) => `${a.id} P=${fmt(a.pnlUsdc)}${a.flags?.length ? ` flags=${a.flags.join("|")}` : ""}`);
  console.log(`  agents: ${agents.join("  ")}`);
  const sumP = (sc.agents ?? []).filter((a) => !a.baseline).reduce((a, x) => a + (x.pnlUsdc ?? 0), 0);
  console.log(`  Σ P (non-baseline) ${fmt(sumP)} vs wave net paid ${fmt(netPaid)}  ${sumP <= netPaid + 1 ? "books close" : "!! P exceeds what the wave paid"}`);
  // agent trades on launch pools
  for (const id of ["launch-sniper", "launch-confirm"]) {
    const p = join(runDir, "agents", `${id}.jsonl`);
    if (!existsSync(p)) continue;
    const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const sub = rows.filter((r) => r.kind === "mempool" && r.event === "submitted").length;
    const rej = rows.filter((r) => r.kind === "mempool" && r.event !== "submitted").length;
    const reasons = {};
    for (const r of rows) if (r.reason) reasons[String(r.reason).slice(0, 40)] = (reasons[String(r.reason).slice(0, 40)] ?? 0) + 1;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  ${id}: submitted ${sub}, not-included/rejected ${rej}; top reasons: ${top}`);
  }
}
