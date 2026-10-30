// Liquity's MCR is 130%, not the 110% Liquity ships (deployer/vendor/liquity-mcr.patch).
//
// A Trove is a long ETH position with limited liability: below 100% ICR its owner walks away and the
// environment's unscored Stability Pool absorbs the rest. At 110% that is ~11x, and a Trove opened at
// MCR and hedged with a GMX short turned an official down gap into a convex payoff. 130% is the ratio
// at which the largest official down gap leaves a Trove opened at MCR solvent. Pinned here: that the
// patch builds in the value the coordinator checks for, that the check refuses an old dump where a
// re-bake is the fix and only warns where it is not, and that the official regimes are calibrated
// against 1.30 (the gap bound, and the victims the gaps are meant to break).
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Dynamic: sdk/src/constants.ts picks its address overlay at import time, from the env set above.
const { LIQUITY_MCR_WAD, liquityMcrEnforcement, liquityMcrMessage } = await import(
  "../core/src/realtime/liquity.js"
);
const { liquityBreachMagnitude } = await import("../core/src/liquityVictims.js");
const { loadRunConfig } = await import("../core/src/runConfig.js");

const ROOT = resolve(import.meta.dirname, "..");
const WAD = 10n ** 18n;
const MCR = Number(LIQUITY_MCR_WAD) / 1e18;
const CCR = 1.5; // Liquity's, unpatched
const OLD_MCR_WAD = 1_100_000_000_000_000_000n;

test("the vendor patch builds in the MCR the coordinator checks for", () => {
  const patch = readFileSync(resolve(ROOT, "deployer/vendor/liquity-mcr.patch"), "utf8");
  const removed = patch.match(/^-\s+uint constant public MCR = (\d+);/m);
  const added = patch.match(/^\+\s+uint constant public MCR = (\d+);/m);
  assert.ok(removed && added, "the patch edits the MCR constant");
  assert.equal(BigInt(removed![1]), OLD_MCR_WAD, "against Liquity's 110%");
  assert.equal(BigInt(added![1]), LIQUITY_MCR_WAD);
  assert.equal(LIQUITY_MCR_WAD, (13n * WAD) / 10n);
  // CCR is untouched, so Recovery Mode still starts above the individual floor.
  assert.ok(!/^[+-]\s+uint constant public CCR/m.test(patch));
  assert.ok(MCR < CCR);
  // The deployer's own read-back asserts the same value before a dump can be baked.
  const deployer = readFileSync(resolve(ROOT, "deployer/src/protocols/liquity.ts"), "utf8");
  assert.match(deployer, /const LIQUITY_MCR = parseEther\("1\.3"\);/);
  // And setup-vendors.sh applies it before Liquity is built.
  const setup = readFileSync(resolve(ROOT, "deployer/scripts/setup-vendors.sh"), "utf8");
  const section = setup.slice(setup.indexOf("Setting up Liquity"));
  const apply = section.indexOf('apply "../../$LIQUITY_PATCH"');
  assert.ok(apply > 0, "setup-vendors.sh applies the Liquity patch");
  assert.ok(apply < section.indexOf("forge build"), "before the build");
  assert.match(setup, /LIQUITY_PATCH="vendor\/liquity-mcr\.patch"/);
});

test("a deployment without the patch stops a fresh epoch and warns where a re-bake is not the fix", () => {
  const fresh = { external: false, resume: false };
  assert.equal(liquityMcrEnforcement(LIQUITY_MCR_WAD, fresh), "pass");
  assert.equal(liquityMcrEnforcement(LIQUITY_MCR_WAD, { external: true, resume: true }), "pass");
  // A backtest epoch on a dump baked before the patch.
  assert.equal(liquityMcrEnforcement(OLD_MCR_WAD, fresh), "fail");
  // The practice devnet runs anvil, so chainMode alone would not spare it: a resumed period warns.
  assert.equal(liquityMcrEnforcement(OLD_MCR_WAD, { external: false, resume: true }), "warn");
  assert.equal(liquityMcrEnforcement(OLD_MCR_WAD, { external: true, resume: false }), "warn");
  // A read that failed is not a pass.
  assert.equal(liquityMcrEnforcement(null, fresh), "fail");
  assert.equal(liquityMcrEnforcement(null, { external: false, resume: true }), "warn");
  // Anything but the exact value, either way.
  assert.equal(liquityMcrEnforcement(LIQUITY_MCR_WAD + 1n, fresh), "fail");
});

test("the message names the leverage and the fix for the case at hand", () => {
  const fail = liquityMcrMessage(OLD_MCR_WAD, "fail");
  assert.match(fail, /MCR is 1\.10, not 1\.30/);
  assert.match(fail, /~11\.0x/);
  assert.match(fail, /npm run gen:state-dump/);
  assert.match(fail, /setup-vendors\.sh/);
  const warn = liquityMcrMessage(OLD_MCR_WAD, "warn");
  assert.match(warn, /Continuing anyway/);
  assert.doesNotMatch(warn, /gen:state-dump/);
  assert.match(liquityMcrMessage(null, "fail", "execution reverted"), /could not read TroveManager\.MCR\(\) \(execution reverted\)/);
});

// ---- the official regimes against MCR 1.30 ----

const OFFICIAL: string[] = (
  parseYaml(readFileSync(resolve(ROOT, "config/scenarios/public.yaml"), "utf8")) as {
    regimes: string[];
  }
).regimes;
const load = (regime: string) =>
  loadRunConfig(`config/regimes/${regime}.yaml`, { SEED: 101 }).config;
const range = (r: number | [number, number]): [number, number] => (Array.isArray(r) ? r : [r, r]);

test("no official down gap takes a Trove opened at MCR under 100% ICR", () => {
  // The reason for 1.30: a Trove at MCR · (1 − m) stays above 1 for every gap that can go down -- a
  // crash, or a spike that may flip. 1 − 1/1.30 = 23.1 %; the largest official down gap is 22 %.
  const bound = 1 - 1 / MCR;
  let downGaps = 0;
  for (const regime of OFFICIAL)
    for (const ev of load(regime).stressEvents) {
      const down = ev.type === "crash" || (ev.type === "spike" && (ev.flipProb ?? 0) > 0);
      if (!down) continue;
      downGaps++;
      const [, hi] = range(ev.magnitudeRange);
      assert.ok(hi < bound, `${regime}: a ${(hi * 100).toFixed(0)} % down gap would take a Trove at MCR ${MCR} to ${(MCR * (1 - hi)).toFixed(3)}`);
    }
  assert.ok(downGaps >= 3, "crash, lending-incident and cdp-incident gap down");
  // At the old 1.10 the same gaps went through the floor, which is what the patch closes.
  assert.ok(1.1 * (1 - 0.22) < 1);
});

test("the official victims open above MCR and every incident's gap still breaks them", () => {
  for (const regime of OFFICIAL) {
    const c = load(regime);
    assert.ok(c.stressLiquityVictimIcr > MCR, `${regime}: victims open at ${c.stressLiquityVictimIcr}, MCR is ${MCR}`);
    // A gap the victims are the point of -- a crash that cannot flip -- breaches every drawn size.
    const threshold = liquityBreachMagnitude(c.stressLiquityVictimIcr, MCR);
    for (const ev of c.stressEvents)
      if (ev.type === "crash" && (ev.flipProb ?? 0) === 0)
        assert.ok(range(ev.magnitudeRange)[0] > threshold, `${regime}: a ${range(ev.magnitudeRange)[0]} crash misses the cohort (threshold ${threshold.toFixed(3)})`);
  }
  // 1.42 is breached by the same fall as 1.20 was against 1.10, so the decoy rates of ADR 0029
  // Amendment 2 (Liquity ~5% of walk-only epochs) carry over.
  const now = liquityBreachMagnitude(1.42, MCR);
  const before = liquityBreachMagnitude(1.2, 1.1);
  assert.ok(Math.abs(now - before) < 0.002, `${now} vs ${before}`);
});
