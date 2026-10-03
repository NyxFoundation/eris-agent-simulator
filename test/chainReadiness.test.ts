// The readiness probe answers the one question an operator has to settle before taking the
// environment down: can a coordinator still start on this chain?
//
// The probe matters because the answer is not reversible in both directions. A chain the checks
// refuse has to be redeployed, and redeploying a practice period resets its standings. What the
// tests below pin is the rule that decides it, which the probe shares with the coordinator rather
// than restating: a frozen vendor reserve is fine when only the treasury is left in it, and a
// participant's position in one is not something the operator can clear.
import test from "node:test";
import assert from "node:assert/strict";
import {
  strayAaveReserves,
  type AaveReserveState,
} from "../core/src/realtime/aaveReserveGuard.js";
import { lqtyStakeProblem, MIN_ENV_LQTY_STAKE_WEI } from "../core/src/realtime/liquity.js";

const OURS = "0x0000000000000000000000000000000000000011" as const;
const VENDOR = "0x0000000000000000000000000000000000000022" as const;

const reserve = (o: Partial<AaveReserveState>): AaveReserveState => ({
  asset: VENDOR,
  active: true,
  frozen: false,
  ltvBps: 8000,
  liquidationThresholdBps: 8500,
  participantSupply: 0n,
  debt: 0n,
  ...o,
});

test("a closed vendor market lets a live migration through; a participant's position does not", () => {
  const ours = new Set([OURS.toLowerCase()]);

  // The shape after `close:aave-vendor` on a market nobody entered: deactivated, or frozen with
  // nothing but the treasury's interest left. Both clear the check, so the chain can be migrated
  // in place and the period's standings survive.
  assert.deepEqual(
    strayAaveReserves(
      [
        reserve({ asset: OURS, active: true }),
        reserve({ active: false }),
        reserve({ frozen: true }),
      ],
      ours,
    ),
    [],
  );

  // A frozen reserve a participant still supplies into, or still owes in, stays a finding. This is
  // the case the operator cannot fix: the position belongs to a participant.
  for (const held of [
    reserve({ frozen: true, participantSupply: 1n }),
    reserve({ frozen: true, debt: 1n }),
  ]) {
    const stray = strayAaveReserves([held], ours);
    assert.equal(stray.length, 1);
    assert.ok(stray[0].participantSupply > 0n || stray[0].debt > 0n);
  }

  // An active vendor reserve is a finding whatever is in it -- that is the hole itself.
  assert.equal(strayAaveReserves([reserve({})], ours).length, 1);
});

test("the LQTY stake check is a threshold, and the probe reads the same one the coordinator does", () => {
  assert.equal(lqtyStakeProblem(MIN_ENV_LQTY_STAKE_WEI), undefined);
  assert.equal(lqtyStakeProblem(MIN_ENV_LQTY_STAKE_WEI + 1n), undefined);
  // A deployment that predates the environment's stake reads 0, and the message names the redeploy
  // because the stake cannot be placed from the account that holds the LQTY.
  const problem = lqtyStakeProblem(0n);
  assert.ok(problem);
  assert.match(problem, /redeploy/);
  // Just short of the threshold is still refused: the point is a stake large enough that an
  // agent's own stake cannot collect the whole fee stream.
  assert.ok(lqtyStakeProblem(MIN_ENV_LQTY_STAKE_WEI - 1n));
});
