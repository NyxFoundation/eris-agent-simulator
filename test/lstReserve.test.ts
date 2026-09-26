// Issue #129: the LST vault stops raising its redemption rate once the reward reserve is empty, and
// the observation used to keep advertising the configured APY for the rest of the period.
import test from "node:test";
import assert from "node:assert/strict";
import {
  rewardRatePerBlockRay,
  rewardRunway,
} from "../sdk/src/protocols/lst.js";
import { lstReserveExhausted } from "../core/src/realtime/lst.js";

const WEI = 10n ** 18n;

test("runway: blocks the reserve pays at the current pool size and rate", () => {
  // 3%/yr at 1 block = 1 hour on 100 WETH: 0.000342 WETH a block, the rate the issue measured.
  const rate = rewardRatePerBlockRay(300, 3600);
  const r = rewardRunway(rate, 50n * WEI, 100n * WEI, 100n * WEI);
  assert.equal(r.payableRatePerBlockRay, rate);
  assert.ok(
    r.runwayBlocks! > 140_000 && r.runwayBlocks! < 150_000,
    `${r.runwayBlocks}`,
  );
});

test("runway: the practice clock (30 s a block) covers a 35-day period on the seeded pool", () => {
  const rate = rewardRatePerBlockRay(300, 30);
  const r = rewardRunway(rate, 50n * WEI, 100n * WEI, 100n * WEI);
  assert.ok(r.runwayBlocks! > 1_514_594, `${r.runwayBlocks} blocks`);
  // ...and still covers it with ~1,000 WETH staked by participants.
  const busy = rewardRunway(rate, 50n * WEI, 1_000n * WEI, 1_000n * WEI);
  assert.ok(busy.runwayBlocks! > 1_514_594, `${busy.runwayBlocks} blocks`);
});

test("runway: a reserve that cannot cover one more block pays nothing", () => {
  const rate = rewardRatePerBlockRay(300, 3600);
  const perBlock = (100n * WEI * rate) / 10n ** 27n;
  const r = rewardRunway(rate, perBlock - 1n, 100n * WEI, 100n * WEI);
  assert.equal(r.payableRatePerBlockRay, 0n);
  assert.equal(r.runwayBlocks, 0);
  const empty = rewardRunway(rate, 0n, 100n * WEI, 100n * WEI);
  assert.equal(empty.payableRatePerBlockRay, 0n);
});

test("runway: nothing accrues without a rate or without shares", () => {
  assert.equal(
    rewardRunway(0n, 50n * WEI, 100n * WEI, 100n * WEI).runwayBlocks,
    null,
  );
  const rate = rewardRatePerBlockRay(300, 3600);
  assert.equal(rewardRunway(rate, 50n * WEI, 0n, 0n).runwayBlocks, null);
});

type ExhaustInput = Parameters<typeof lstReserveExhausted>[0];
function state(over: Partial<ExhaustInput>): ExhaustInput {
  return {
    configuredApyBps: 300,
    rewardReserveWei: 50n * WEI,
    rewardRunwayBlocks: 100_000,
    ...over,
  } as ExhaustInput;
}

test("exhausted: a rate is set and the reserve cannot cover another block", () => {
  assert.equal(lstReserveExhausted(state({})), false);
  assert.equal(
    lstReserveExhausted(state({ rewardReserveWei: 0n, rewardRunwayBlocks: 0 })),
    true,
  );
  assert.equal(lstReserveExhausted(state({ rewardRunwayBlocks: 0 })), true);
  // No rate configured is not exhaustion: nothing was promised.
  assert.equal(
    lstReserveExhausted(
      state({
        configuredApyBps: 0,
        rewardReserveWei: 0n,
        rewardRunwayBlocks: null,
      }),
    ),
    false,
  );
});
