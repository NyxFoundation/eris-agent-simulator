import test from "node:test";
import assert from "node:assert/strict";
import { EventSchedule, type ResolvedStressEvent, type StressEventType } from "../core/src/realtime/events.js";
import { StressAudit } from "../core/src/realtime/stressAudit.js";

function fixture(type: StressEventType = "crash") {
  const event: ResolvedStressEvent = {
    type, base: "WETH", magnitude: 0.2, startBlock: 10, rampBlocks: 2,
    holdBlocks: 2, decayBlocks: 2, endBlock: 16,
  };
  const log: Record<string, unknown>[] = [];
  const audit = new StressAudit([event], record => log.push(record));
  return { event, log, audit };
}

test("a skipped event window is visible even when the run otherwise completes", () => {
  const { audit, log } = fixture();
  for (const blockIndex of [0, 9, 16, 40])
    audit.price("WETH", blockIndex, 100 + blockIndex, { before: 3000, unoverlaid: 3000, fair: 3000 }, { stage: "price_submitted", hashes: ["0xa"] });
  audit.finish();
  assert.equal(log.filter(e => e.type === "stress_event_applied").length, 0);
  assert.equal(log.find(e => e.type === "stress_event_summary")?.status, "not_observed");
  assert.match(String(log.find(e => e.type === "stress_application_warning")?.reason), /no application evidence/);
});

test("price telemetry matches the actual schedule and retains the published hash per event/base", () => {
  const schedule = new EventSchedule([
    { type: "crash", base: "WETH", magnitudeRange: [0.2, 0.2], windowFrac: [0.25, 0.25], rampBlocks: 2, holdBlocks: 2, decayBlocks: 2 },
    { type: "spike", base: "WBTC", magnitudeRange: [0.1, 0.1], windowFrac: [0.25, 0.25], rampBlocks: 2, holdBlocks: 2, decayBlocks: 2 },
  ], 101, 40);
  const log: Record<string, unknown>[] = [];
  const audit = new StressAudit(schedule.events, e => log.push(e));
  for (let blockIndex = 0; blockIndex < 40; blockIndex++) {
    for (const base of ["WETH", "WBTC"]) {
      const unoverlaid = base === "WETH" ? 3000 : 60_000;
      audit.price(base, blockIndex, blockIndex + 100, {
        before: unoverlaid, unoverlaid, fair: unoverlaid * (schedule.at(blockIndex).baseMults[base] ?? 1),
      }, { stage: "price_submitted", hashes: [`0x${base}${blockIndex}`] });
    }
  }
  const applications = log.filter(e => e.type === "stress_event_applied");
  assert.ok(applications.length > 0);
  for (const e of applications) {
    assert.equal(e.fairPrice, Number(e.unoverlaidPrice) * Number(e.overlayMultiplier));
    assert.deepEqual(e.hashes, [`0x${e.base}${e.blockIndex}`]);
  }
  assert.deepEqual(audit.summaries().map(e => [e.status, e.peakMagnitude]), [["observed", 0.2], ["observed", 0.1]]);
});

test("sampling only a ramp records a partial price event instead of claiming the planned peak", () => {
  const { audit, log } = fixture();
  audit.price("WETH", 10, 110, { before: 3000, unoverlaid: 3010, fair: 2709 }, { stage: "storage_written" });
  audit.finish();
  assert.equal(audit.summaries()[0].peakMagnitude, 0.1);
  assert.equal(audit.summaries()[0].status, "partial");
  assert.ok(log.some(e => e.type === "stress_application_warning"));
});

test("a drift records the applied input without attributing all price movement to it", () => {
  const { event, audit, log } = fixture("cexDrift");
  event.magnitude = 0.002;
  event.side = "sell";
  event.kappaMult = 0.2;
  audit.price("WETH", 11, 111, { before: 3000, unoverlaid: 3005, fair: 3005 }, { stage: "price_submitted", hashes: ["0x1"] });
  assert.equal(log[0].driftAdd, -0.002);
  assert.ok(Math.abs(Number(log[0].kappaMult) - 0.2) < 1e-12);
  assert.equal(log[0].realizedMagnitude, undefined);
  assert.equal(log[0].priceBefore, 3000);
  assert.equal(log[0].fairPrice, 3005);
});

test("flow and execution evidence are distinct from on-chain confirmation; every scheduled entry is accounted for", () => {
  for (const type of ["flowTrend", "whale", "lstSlash", "liquidityPull", "eusdDepeg", "depeg", "tokenLaunch"] as const) {
    const { event, audit, log } = fixture(type);
    assert.equal(audit.summaries()[0].status, "not_observed");
    audit.record(event, 11, 111, type === "flowTrend"
      ? { stage: "flow_context_queued", sizeMult: 3 }
      : { stage: "tx_submitted", hashes: ["0x1"] });
    assert.equal(log[0].eventIndex, 0);
    assert.equal(log[0].eventType, type);
    assert.equal(audit.summaries()[0].status, "observed");
  }
});

test("overlapping price events retain their own multipliers and an inactive base has no evidence", () => {
  const { event } = fixture();
  const other = { ...event, magnitude: 0.1 };
  const inactive = { ...event, base: "WBTC" };
  const log: Record<string, unknown>[] = [];
  const audit = new StressAudit([event, other, inactive], e => log.push(e));
  audit.price("WETH", 11, 111, { before: 3000, unoverlaid: 3000, fair: 2160 }, { stage: "storage_written" });
  assert.deepEqual(log.map(e => e.overlayMultiplier), [0.8, 0.9]);
  assert.equal(audit.summaries()[2].status, "not_observed");
  assert.throws(() => audit.record({ ...event }, 11, 111, { stage: "applied" }), /outside its schedule/);
});
