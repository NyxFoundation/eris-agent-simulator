#!/usr/bin/env node
// infra/devnet/revision-health.mjs -- is every self-improving agent's revision loop still turning?
//
//   node infra/devnet/revision-health.mjs <run dir>/agents [--min-per-hour 1] [--max-fail 0.10] [--json]
//
// Reads the decision logs the runtime writes (`agents/<id>.jsonl`, runtime/agentLog.ts) on the machine
// that ran the agents -- for a participant-role agent that is its own ERIS_RUN_DIR, never the box. Per
// agent that logged at least one revision:
//
//   completed   revisions that ended installed / declined / reverted: the loop ran and the model
//               answered with something the runtime could act on (declining is an answer)
//   llmFailed   `revision rejected` whose reason is `revision failed: ...` -- the call itself failed
//               (timeout, 401, 429 from the inference proxy, an upstream 5xx). Rejections for a bad
//               answer (not JSON, a cheatcode, a compile error) are counted in `rejected`, not here:
//               they are the model's, not the path's
//   perHour     completed revisions in each full hour since the agent's first revision; the check
//               (CHECKLIST.md) wants every hour to have at least one
//   decideTimeouts / decideErrors   `decide timeout:` / `decide error:` lines, reported, not judged
//
// Exit 0 when every agent passes, 1 when one does not, 2 when there is nothing to read.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const VALUED = new Set(["--min-per-hour", "--max-fail"]);
let dir;
for (let i = 0; i < args.length; i++) {
  if (VALUED.has(args[i])) i++;
  else if (!args[i].startsWith("--")) {
    dir = args[i];
    break;
  }
}
const minPerHour = Number(flag("min-per-hour", 1));
const maxFail = Number(flag("max-fail", 0.1));
const asJson = flag("json", false) === true;

if (!dir) {
  console.error("usage: revision-health.mjs <run dir>/agents [--min-per-hour 1] [--max-fail 0.10] [--json]");
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".llm.jsonl"));
const results = [];
for (const f of files) {
  const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
  const revisions = [];
  let decideTimeouts = 0;
  let decideErrors = 0;
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const reason = typeof r.reason === "string" ? r.reason : "";
    if (reason.startsWith("revision ")) revisions.push({ ts: Date.parse(r.ts), kind: reason.slice(9), why: r.state?.reason ?? "" });
    else if (reason.startsWith("decide timeout:")) decideTimeouts++;
    else if (reason.startsWith("decide error:")) decideErrors++;
  }
  if (revisions.length === 0) continue; // a rule-based or frozen agent: no loop to judge

  const done = new Set(["installed", "declined", "reverted"]);
  const completed = revisions.filter((r) => done.has(r.kind));
  const llmFailed = revisions.filter((r) => r.kind === "rejected" && String(r.why).startsWith("revision failed:"));
  const rejected = revisions.filter((r) => r.kind === "rejected").length - llmFailed.length;

  const t0 = revisions[0].ts;
  const tLast = revisions[revisions.length - 1].ts;
  const fullHours = Math.floor((tLast - t0) / 3_600_000);
  const perHour = Array.from({ length: fullHours }, () => 0);
  for (const r of completed) {
    const h = Math.floor((r.ts - t0) / 3_600_000);
    if (h < fullHours) perHour[h]++;
  }
  const failRatio = llmFailed.length / revisions.length;
  const emptyHours = perHour.map((c, h) => (c < minPerHour ? h : -1)).filter((h) => h >= 0);
  const lastFailures = llmFailed.slice(-3).map((r) => String(r.why).slice(0, 160));
  results.push({
    agent: f.replace(/\.jsonl$/, ""),
    revisions: revisions.length,
    completed: completed.length,
    llmFailed: llmFailed.length,
    rejected,
    failRatio: +failRatio.toFixed(4),
    fullHours,
    minPerHour: perHour.length > 0 ? Math.min(...perHour) : null,
    emptyHours,
    decideTimeouts,
    decideErrors,
    lastFailures,
    why: [
      ...(fullHours === 0 ? ["less than one full hour of revisions: nothing to judge yet"] : []),
      ...(failRatio >= maxFail ? [`llm failures ${(failRatio * 100).toFixed(1)}% >= ${maxFail * 100}%`] : []),
      ...(emptyHours.length > 0 ? [`hours with fewer than ${minPerHour} completed: ${emptyHours.join(", ")}`] : []),
    ],
    pass: failRatio < maxFail && emptyHours.length === 0 && fullHours > 0,
  });
}

if (results.length === 0) {
  console.error(`revision-health: no agent in ${dir} logged a revision`);
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("agent                         revs  done  llmFail  rejected  fail%  hours  min/h  timeouts  verdict");
  for (const r of results) {
    console.log(
      `${r.agent.padEnd(28)}  ${String(r.revisions).padStart(4)}  ${String(r.completed).padStart(4)}  ${String(r.llmFailed).padStart(7)}  ${String(r.rejected).padStart(8)}  ${(r.failRatio * 100).toFixed(1).padStart(5)}  ${String(r.fullHours).padStart(5)}  ${String(r.minPerHour ?? "-").padStart(5)}  ${String(r.decideTimeouts).padStart(8)}  ${r.pass ? "PASS" : "FAIL"}`,
    );
    for (const why of r.why) console.log(`    ${why}`);
    for (const why of r.lastFailures) console.log(`    llm failure: ${why}`);
  }
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
