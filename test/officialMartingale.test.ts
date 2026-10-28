// The official regimes' fair price is a martingale within the epoch (ADR 0029).
//
// The OU walk reverted toward the opening fair, which is the same $3,000 / $60,000 in every epoch
// and readable at block 0, so "trade toward the opening level" was a positive expectation in every
// regime, net of fees, with leverage as its only bound (scripts/measurePredictability.ts). With
// kappa 0 there is nothing to revert to. A regime that leaves `market.kappa` unset inherits the sdk
// default (0.02, kept for configs outside the official set), which is how every official regime but
// three had it -- so the value is asserted per regime and per base rather than trusted to a default.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const { loadRunConfig } = await import("../core/src/runConfig.js");

const ROOT = resolve(import.meta.dirname, "..");
const OFFICIAL: string[] = (
  parseYaml(readFileSync(resolve(ROOT, "config/scenarios/public.yaml"), "utf8")) as {
    regimes: string[];
  }
).regimes;
const load = (regime: string) =>
  loadRunConfig(`config/regimes/${regime}.yaml`, { SEED: 101 }).config;

test("every official regime walks every base with no mean reversion", () => {
  assert.equal(OFFICIAL.length, 12);
  for (const regime of OFFICIAL) {
    const { ou } = load(regime);
    assert.equal(ou.global.kappa, 0, `${regime}: market.kappa`);
    for (const [base, params] of Object.entries(ou.perBase))
      assert.equal(params.kappa, 0, `${regime}: ${base} reverts (kappa ${params.kappa})`);
  }
});

test("no official event reshapes a reversion that is not there", () => {
  // kappaMult and repriceAnchor act on the OU's reversion and on the level it reverts to. Under
  // kappa 0 both do nothing, so a regime that still set them would read as a regime it is not.
  for (const regime of OFFICIAL)
    for (const ev of load(regime).stressEvents) {
      assert.equal(ev.kappaMultRange, undefined, `${regime}: ${ev.type}.kappaMultRange`);
      assert.equal(ev.repriceAnchor, undefined, `${regime}: ${ev.type}.repriceAnchor`);
      assert.equal(ev.repriceAnchorProb, undefined, `${regime}: ${ev.type}.repriceAnchorProb`);
    }
});

// ---- price gaps (ADR 0029 Amendment 1) ----

const GAPS = new Set(["crash", "spike"]);
const mean = (r: number | [number, number]) => (Array.isArray(r) ? (r[0] + r[1]) / 2 : r);
const upper = (r: number | [number, number]) => (Array.isArray(r) ? r[1] : r);

test("an official gap stays where it lands and is over before an order can join it", () => {
  // A gap that recovered on a straight line could be faded once it stalled (recoverFrac above 0) or
  // followed once the decay began; a ramp longer than the two blocks between seeing a step and
  // filling on it left its last steps to whoever joined.
  let gaps = 0;
  for (const regime of OFFICIAL)
    for (const ev of load(regime).stressEvents) {
      if (!GAPS.has(ev.type)) continue;
      gaps++;
      assert.deepEqual(ev.recoverFrac, [0, 0], `${regime}: ${ev.type}.recoverFrac`);
      assert.ok(upper(ev.rampBlocks) <= 3, `${regime}: ${ev.type}.rampBlocks reaches ${upper(ev.rampBlocks)}`);
    }
  assert.equal(gaps, 4, "crash, spike, lending-incident and cdp-incident each carry one gap event");
});

test("across the official mix the expected gap is about zero", () => {
  // Gaps that stay make the mix's expected gap a standing edge for whoever holds less base than the
  // basket. Every regime is drawn with equal odds (rules §3.3), so the sum over regimes is what an
  // agent faces at block 0: sign x (1 - 2 flipProb) x expected count x expected magnitude.
  let sum = 0;
  const starts = new Set<string>();
  for (const regime of OFFICIAL)
    for (const ev of load(regime).stressEvents) {
      if (!GAPS.has(ev.type)) continue;
      const sign = ev.type === "spike" ? 1 : -1;
      const count = ev.count === undefined ? 1 : mean(ev.count);
      sum += sign * (1 - 2 * (ev.flipProb ?? 0)) * count * mean(ev.magnitudeRange);
      starts.add(JSON.stringify(ev.windowFrac));
    }
  const perEpoch = sum / OFFICIAL.length;
  assert.ok(Math.abs(perEpoch) < 0.002, `expected gap per epoch ${(perEpoch * 100).toFixed(2)}%`);
  // Gaps that may start at different points would make "none yet" say which way the next one goes.
  assert.equal(starts.size, 1, `gap windows start in different bands: ${[...starts].join(" ")}`);
});

test("no official regime gives up the event list's salt", () => {
  // stress.saltWithEventList: false exists for the practice period, which revises its unplayed
  // episodes mid-way (ADR 0029 Amendment 3). The official regimes share seeds across regimes, and the
  // salt is what keeps crash#s and spike#s from drawing the same windows (events.ts EventSchedule).
  for (const regime of OFFICIAL)
    assert.equal(load(regime).stressSaltWithEventList, undefined, `${regime}: stress.saltWithEventList`);
});

test("no official episode leans the walk one way", () => {
  // A cexDrift held a side for 30-54 blocks, readable in ~10 and worth +540 to +700 bps of notional
  // to whoever followed it (ADR 0029 Amendment 4). The cex-drift regime runs volBursts: faster, no side.
  for (const regime of OFFICIAL)
    for (const ev of load(regime).stressEvents)
      assert.notEqual(ev.type, "cexDrift", `${regime}: a cexDrift episode`);
  assert.ok(load("cex-drift").stressEvents.some((ev) => ev.type === "volBurst"));
});
