// GMX funding and open interest, from the DataStore key to the strategy that prices it (issue #78).
//
// The environment has charged funding since deployer/vendor/gmx-localhost.patch, and the post-run
// market series has reported it, but no agent could see it. These pin the three things that made
// the value trustworthy once it reached the observation: the keys are the ones Keys.sol derives, a
// failed read is absent rather than zero, and a zero rate from a deploy without funding is
// distinguishable from a zero rate on a balanced book.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  gmxFundingFeeAmount,
  gmxFundingFeeAmountPerSizeKey,
  gmxFundingFields,
  gmxFundingIncreaseFactorKey,
  gmxOpenInterestKey,
  gmxSavedFundingKey,
} from "@eris/sdk/protocols/gmxKeys.js";
import { fundingCarryBpsPerBlock } from "../example/agents/basis-arb/agent.js";
import type { AgentObservation, GmxObservation } from "@eris/sdk/types.js";

const MARKET = "0x1111111111111111111111111111111111111111" as Address;
const COLLATERAL = "0x2222222222222222222222222222222222222222" as Address;

// GMX carries USD at 30 decimals.
const usd30 = (usd: number) => BigInt(Math.round(usd)) * 10n ** 30n;

// ---------------------------------------------------------------------------
// keys

test("gmxOpenInterestKey matches the Keys.sol derivation", () => {
  // Expected values computed independently with `cast keccak` / `cast abi-encode`
  // over gmx-synthetics contracts/data/Keys.sol's formula.
  assert.equal(
    gmxOpenInterestKey(MARKET, COLLATERAL, true),
    "0xe9b069bb2833eb4c6757fe3e2aec8f60b75f0f7a3b89a787f90542c579dd5e0b",
  );
});

test("the funding keys are distinct per market, per side and per accumulator", () => {
  // Not a hash fixture: what would actually break is two keys colliding or a side being ignored,
  // which is exactly what reading the wrong cell of the DataStore looks like from the outside.
  const keys = [
    gmxSavedFundingKey(MARKET),
    gmxFundingIncreaseFactorKey(MARKET),
    gmxFundingFeeAmountPerSizeKey(MARKET, COLLATERAL, true),
    gmxFundingFeeAmountPerSizeKey(MARKET, COLLATERAL, false),
    gmxOpenInterestKey(MARKET, COLLATERAL, true),
    gmxOpenInterestKey(MARKET, COLLATERAL, false),
  ];
  assert.equal(new Set(keys).size, keys.length);
  // A different market must not read another market's state.
  assert.notEqual(
    gmxSavedFundingKey(MARKET),
    gmxSavedFundingKey(COLLATERAL as Address),
  );
});

// ---------------------------------------------------------------------------
// decode

test("the fields are present and correctly signed on a deploy with funding", () => {
  // The measured skew from the 485-block run that showed funding was structurally zero:
  // 74,651 USD long against 54,752 short, all of it collateralized in the short token.
  const fields = gmxFundingFields({
    openInterest: [0n, usd30(74_651), 0n, usd30(54_752)],
    // 2e-8 per second (the deployed factor at a 100% skew) as a 30-decimal fraction.
    savedFundingFactorPerSecond: 20_000_000_000_000_000_000_000n,
    fundingIncreaseFactorPerSecond: 1n,
  });
  assert.equal(fields.longOiUsd, 74_651);
  assert.equal(fields.shortOiUsd, 54_752);
  assert.equal(fields.fundingModeled, true);
  // 2e-8/s * 3600 s * 1e4 bps = 0.72 bps per hour. Over a 12-minute epoch that is 0.144 bps of
  // notional -- the magnitude that keeps this a cost term rather than a carry trade.
  assert.equal(fields.fundingPerHourBps, 0.72);
  assert.ok((fields.fundingPerHourBps ?? 0) * 0.2 < 0.15);
});

test("a negative saved factor keeps its sign: shorts pay longs", () => {
  const fields = gmxFundingFields({
    openInterest: [0n, usd30(10_000), 0n, usd30(40_000)],
    savedFundingFactorPerSecond: -20_000_000_000_000_000_000_000n,
    fundingIncreaseFactorPerSecond: 1n,
  });
  assert.equal(fields.fundingPerHourBps, -0.72);
  // ...and the sign agrees with the skew that produced it: the short side is the crowded one.
  assert.ok((fields.shortOiUsd ?? 0) > (fields.longOiUsd ?? 0));
});

test("a failed read leaves the field absent, never 0", () => {
  const noFunding = gmxFundingFields({
    openInterest: [0n, usd30(1_000), 0n, usd30(1_000)],
  });
  assert.equal(noFunding.longOiUsd, 1_000);
  assert.ok(!("fundingPerHourBps" in noFunding));
  assert.ok(!("fundingModeled" in noFunding));

  // One failed OI cell drops the whole skew: half a skew is not a smaller skew, it is a wrong one.
  const noOi = gmxFundingFields({
    openInterest: [0n, usd30(1_000), undefined, usd30(1_000)],
    savedFundingFactorPerSecond: 0n,
  });
  assert.ok(!("longOiUsd" in noOi));
  assert.ok(!("shortOiUsd" in noOi));
  assert.equal(noOi.fundingPerHourBps, 0);

  // Nothing read at all is every field absent, not a zeroed venue.
  assert.deepEqual(gmxFundingFields({}), {});
});

test("a pre-patch state dump reports fundingModeled: false, not a balanced book", () => {
  // What every deploy looked like before the localhost market config gained funding parameters:
  // a skewed book, and savedFundingFactorPerSecond stuck at 0 because MarketUtils never writes it
  // when fundingIncreaseFactorPerSecond is 0.
  const fields = gmxFundingFields({
    openInterest: [0n, usd30(74_651), 0n, usd30(54_752)],
    savedFundingFactorPerSecond: 0n,
    fundingIncreaseFactorPerSecond: 0n,
  });
  assert.equal(fields.fundingPerHourBps, 0);
  assert.equal(fields.fundingModeled, false);
  // The skew is real and the rate is not. That pair is the whole point of the flag: without it a
  // reader would conclude from `0` that the book was flat, with 20k USD of skew sitting next to it.
  assert.notEqual(fields.longOiUsd, fields.shortOiUsd);
});

test("the position's accrued funding is the per-size delta scaled by 1e45", () => {
  // MarketUtils.getFundingAmount: sizeInUsd * (latest - snapshot) / (FLOAT_PRECISION *
  // FLOAT_PRECISION_SQRT) = /1e45. A 10,000 USD position (1e34) against a per-size delta of 1e18
  // owes 1e7 collateral units -- 10 USDC, since the fee is denominated in the collateral token.
  const size = usd30(10_000);
  assert.equal(gmxFundingFeeAmount(10n ** 18n, 0n, size), 10n ** 7n);
  // Nothing accrued since the snapshot.
  assert.equal(gmxFundingFeeAmount(10n ** 18n, 10n ** 18n, size), 0n);
  // The paid side never accumulates here (its credit goes to the claimable keys), so a snapshot
  // above the latest value is a floor at zero rather than a negative fee.
  assert.equal(gmxFundingFeeAmount(0n, 10n ** 18n, size), 0n);
});

// ---------------------------------------------------------------------------
// basis-arb's carry term

function obsWith(gmx: GmxObservation | undefined): AgentObservation {
  // Only the fields fundingCarryBpsPerBlock reads; an AgentObservation carries thirty more that
  // would be noise here.
  return { protocols: gmx ? { gmx } : {} } as unknown as AgentObservation;
}

const shortPosition = {
  isLong: false,
  sizeUsd: (10_000n * 10n ** 30n).toString(),
  sizeInTokens: "0",
  collateral: "USDC" as const,
  collateralAmount: "0",
  entryPriceUsd: 3000,
  pnlUsd: 0,
};
const longPosition = { ...shortPosition, isLong: true };

test("the carry credits a hedge on the thin side and charges one on the crowded side", () => {
  const rate = { marketPriceUsd: 3000, fundingPerHourBps: 0.72 };
  // Positive rate = longs pay shorts, so the short hedge is paid.
  const short = fundingCarryBpsPerBlock(
    obsWith({ ...rate, fundingModeled: true, position: shortPosition }),
  );
  const long = fundingCarryBpsPerBlock(
    obsWith({ ...rate, fundingModeled: true, position: longPosition }),
  );
  assert.ok(short > 0, "a short hedge is paid when longs pay shorts");
  assert.equal(long, -short);
  // 0.72 bps/hour at 2s blocks = 0.0004 bps per block. Over the two-block hedge delay the cost
  // model charges 0.0008 bps -- which is the point: it has the right sign and no weight.
  assert.ok(Math.abs(short - 0.0004) < 1e-9);
});

test("the carry is zero whenever the rate is not a measurement", () => {
  const withPos = (extra: Partial<GmxObservation>) =>
    fundingCarryBpsPerBlock(
      obsWith({
        marketPriceUsd: 3000,
        position: shortPosition,
        ...extra,
      } as GmxObservation),
    );
  // A deploy that does not model funding: the 0 rate says nothing about the book.
  assert.equal(withPos({ fundingPerHourBps: 0, fundingModeled: false }), 0);
  // ...and neither does a nonzero rate read off such a deploy, if one ever appeared.
  assert.equal(withPos({ fundingPerHourBps: 0.72, fundingModeled: false }), 0);
  // A failed read.
  assert.equal(withPos({ fundingModeled: true }), 0);
  // The venue is not in this run at all.
  assert.equal(fundingCarryBpsPerBlock(obsWith(undefined)), 0);
  // A flat perp has no side to be paid on, so there is no carry to price yet.
  assert.equal(
    fundingCarryBpsPerBlock(
      obsWith({
        marketPriceUsd: 3000,
        fundingPerHourBps: 0.72,
        fundingModeled: true,
      }),
    ),
    0,
  );
});
