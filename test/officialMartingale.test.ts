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
