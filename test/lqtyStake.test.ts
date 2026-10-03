// The coordinator refuses a Liquity deployment whose LQTYStaking has no environment stake: with
// nothing staked, the first agent to stake a few Stability Pool LQTY collects every fee of the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lqtyStakeProblem,
  MIN_ENV_LQTY_STAKE_WEI,
} from "../core/src/realtime/liquity.js";

const WAD = 10n ** 18n;

test("a deployment with the environment's 2M stake starts", () => {
  assert.equal(lqtyStakeProblem(2_000_000n * WAD), undefined);
  assert.equal(lqtyStakeProblem(MIN_ENV_LQTY_STAKE_WEI), undefined);
});

test("a deployment nobody staked on is refused, naming the re-bake", () => {
  const msg = lqtyStakeProblem(0n);
  assert.ok(msg);
  assert.match(msg, /0 LQTY staked/);
  assert.match(msg, /gen:state-dump/);
});

test("an agent-sized stake is not the environment's", () => {
  // What a sole Stability Pool depositor earned over 360 blocks on cdp-incident#101.
  assert.ok(lqtyStakeProblem(30n * WAD));
});
