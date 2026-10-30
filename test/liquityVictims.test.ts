// Issue #107: the Liquity victim cohort. The chain-facing half (open, read back, refuse) runs on a
// deployed venue; what is pinned here is the pure half -- the keys, the debt sizing that lands a
// Trove at ICR₀ once Liquity adds the fee and the gas compensation, and the breach threshold the
// calibration warning reads.
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLiquityVictims,
  liquityBreachMagnitude,
  victimDebtForIcr,
} from "../core/src/liquityVictims.js";
import { deriveStressVictims } from "../core/src/stressVictims.js";

const WAD = 10n ** 18n;

test("the cohort is stable within a process and never collides with the Aave cohort", () => {
  const a = deriveLiquityVictims(2);
  const b = deriveLiquityVictims(2);
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((v) => v.id), ["liquity-victim-0", "liquity-victim-1"]);
  assert.notEqual(a[0].address, a[1].address);
  const aave = deriveStressVictims(2).map((v) => v.address.toLowerCase());
  for (const v of a) assert.ok(!aave.includes(v.address.toLowerCase()));
  assert.deepEqual(deriveLiquityVictims(0), []);
});

test("victimDebtForIcr sizes the request so the composite debt lands on ICR₀", () => {
  const collWei = 5n * WAD; // 5 ETH
  const priceWad = 3000n * WAD; // $3,000
  const rate = WAD / 200n; // 0.5 % borrowing fee (the floor)
  const gasComp = 200n * WAD;
  const debt = victimDebtForIcr({ collWei, priceWad, icr0: 1.2, borrowingRateWad: rate, gasCompensationWei: gasComp });
  // Liquity books debt + fee + gas compensation; the ICR on that composite must be 1.20.
  const composite = debt + (debt * rate) / WAD + gasComp;
  const icr = Number((collWei * priceWad) / composite) / 1e18;
  assert.ok(Math.abs(icr - 1.2) < 1e-6, `ICR ${icr}`);
  // 5 × 3000 / 1.2 = 12,500 total → 12,300 before the fee → ≈ 12,238.8 requested.
  assert.ok(debt > 12_238n * WAD && debt < 12_239n * WAD, `debt ${debt}`);
  // A Trove too small for the gas compensation cannot be sized.
  assert.equal(victimDebtForIcr({ collWei: WAD / 100n, priceWad, icr0: 1.2, borrowingRateWad: rate, gasCompensationWei: gasComp }), 0n);
});

test("the breach threshold is 1 − MCR/ICR₀, and the official regime's crash clears it", () => {
  // MCR is 1.30 (deployer/vendor/liquity-mcr.patch), and the official cohort opens at 1.42.
  const m = liquityBreachMagnitude(1.42, 1.3);
  assert.ok(Math.abs(m - (1 - 1.3 / 1.42)) < 1e-12);
  assert.ok(m < 0.12, "cdp-incident's crash floor (12 %) breaches a 1.42 Trove");
  assert.ok(liquityBreachMagnitude(1.3, 1.3) === 0);
});

// Issue #59: the cohort that reaches Recovery Mode. The genesis Trove (350 ETH / 351,950 eUSD of
// composite debt) holds the system at ~300 %; a crash of 20 % leaves it at 2.39, far above CCR 1.5.
// The sizing has to find the collateral per victim -- at ICR₀ -- that brings the system TCR to the
// target at the bottom. The numbers are config/regimes/cdp-recovery.yaml's at its shallowest draw.
test("recoveryCohortCollateralWei sizes a cohort that lands the system on the target TCR", async () => {
  const { recoveryCohortCollateralWei, tcrAtCrashBottom } = await import("../core/src/liquityVictims.js");
  const gc = 350n * WAD;
  const gd = 351_950n * WAD;
  const priceWad = 3000n * WAD;
  const icr0 = 1.69;
  const m = 0.2;
  const count = 24;
  const c = recoveryCohortCollateralWei({ systemCollWei: gc, systemDebtWei: gd, priceWad, crashMagnitude: m, icr0, count, targetTcr: 1.45 });
  assert.ok(c !== null && c > 0n);
  // Put the cohort in (debt = c·P/ICR₀ each) and read the TCR at the bottom: it is the target.
  const n = BigInt(count);
  const debtEach = (c! * priceWad) / (BigInt(Math.round(icr0 * 1e6)) * (WAD / 1_000_000n));
  const tcr = tcrAtCrashBottom({ systemCollWei: gc + n * c!, systemDebtWei: gd + n * debtEach, priceWad, crashMagnitude: m });
  assert.ok(Math.abs(tcr - 1.45) < 1e-3, `TCR at the bottom ${tcr}`);
  // Below CCR, i.e. Recovery Mode; and the cohort itself is still above MCR 1.30 there (1.69 × 0.80
  // = 1.352), so it is liquidatable only because of Recovery Mode.
  assert.ok(tcr < 1.5 && icr0 * (1 - m) > 1.3 && icr0 * (1 - 0.22) > 1.3);
  // Each Trove's debt fits the Stability Pool the regime stands up (125k genesis + 100k seeded), so
  // a Recovery Mode liquidation -- which needs the pool to absorb the whole debt -- can execute.
  assert.ok(debtEach < 225_000n * WAD, `debt per victim ${debtEach / WAD}`);
  // Unreachable: a target *below* the cohort's own post-crash ICR (1.352) cannot be produced by
  // adding Troves at that ICR -- the system's TCR converges on the cohort's ICR from above.
  assert.equal(recoveryCohortCollateralWei({ systemCollWei: gc, systemDebtWei: gd, priceWad, crashMagnitude: m, icr0, count, targetTcr: 1.3 }), null);
  // Any target between the two is reachable, with more collateral the closer it sits to the cohort's ICR.
  const c14 = recoveryCohortCollateralWei({ systemCollWei: gc, systemDebtWei: gd, priceWad, crashMagnitude: m, icr0, count, targetTcr: 1.4 });
  assert.ok(c14 !== null && c14 > c!);
  assert.equal(recoveryCohortCollateralWei({ systemCollWei: 100n * WAD, systemDebtWei: 250_000n * WAD, priceWad, crashMagnitude: m, icr0, count, targetTcr: 1.45 }), null);
});
