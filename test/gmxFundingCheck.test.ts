// A local deployment on which GMX has no funding is refused at setup.
//
// Funding is non-zero only on deploys baked after deployer/vendor/gmx-localhost.patch gained funding
// parameters (a35cf3e). An older state dump has FUNDING_INCREASE_FACTOR_PER_SECOND = 0 on every
// market, so the funding rate is 0 on every block and `fundingModeled` is false -- and the run used
// to go ahead anyway, with nothing saying it was a different economy.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  gmxFundingCheck,
  gmxFundingEnforcement,
  gmxFundingMissingMessage,
  readGmxFundingConfig,
} from "../core/src/realtime/gmxFunding.js";
import { GMX } from "@eris/sdk/constants.js";
import { gmxFundingIncreaseFactorKey } from "@eris/sdk/protocols/gmxKeys.js";

const ETH = "0x00000000000000000000000000000000000000e1" as Address;
const BTC = "0x00000000000000000000000000000000000000b1" as Address;
// Any non-zero increase factor, as a deploy with the funding patch has (1e30 factor precision).
const PATCHED = 10n ** 22n;

test("every market modeling funding passes, and the event carries each market's value", () => {
  const check = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: PATCHED },
    { base: "WBTC", market: BTC, fundingIncreaseFactorPerSecond: PATCHED },
  ]);
  assert.equal(check.ok, true);
  assert.deepEqual(check.unmodeled, []);
  assert.deepEqual(check.unread, []);
  assert.deepEqual(check.markets, [
    {
      base: "WETH",
      market: ETH,
      fundingIncreaseFactorPerSecond: PATCHED.toString(),
      fundingModeled: true,
    },
    {
      base: "WBTC",
      market: BTC,
      fundingIncreaseFactorPerSecond: PATCHED.toString(),
      fundingModeled: true,
    },
  ]);
});

test("a pre-funding deploy (increase factor 0) fails and the message names the fix", () => {
  const check = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: 0n },
    { base: "WBTC", market: BTC, fundingIncreaseFactorPerSecond: 0n },
  ]);
  assert.equal(check.ok, false);
  assert.deepEqual(check.unmodeled, [`WETH (${ETH})`, `WBTC (${BTC})`]);
  assert.equal(check.markets[0].fundingModeled, false);
  const message = gmxFundingMissingMessage(check);
  assert.match(message, /GMX funding is not modeled on this deployment/);
  assert.match(message, /FUNDING_INCREASE_FACTOR_PER_SECOND is 0/);
  assert.match(message, /predates GMX funding/);
  assert.match(message, /npm run deploy -- --keep-fresh/);
  assert.match(message, /npm run gen:state-dump/);
});

test("one market without funding is enough to fail", () => {
  const check = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: PATCHED },
    { base: "WBTC", market: BTC, fundingIncreaseFactorPerSecond: 0n },
  ]);
  assert.equal(check.ok, false);
  assert.deepEqual(check.unmodeled, [`WBTC (${BTC})`]);
});

test("a config that cannot be read fails rather than passing as 'could not tell'", () => {
  const check = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: PATCHED },
    { base: "WBTC", market: BTC, error: "execution reverted" },
  ]);
  assert.equal(check.ok, false);
  assert.deepEqual(check.unmodeled, []);
  assert.deepEqual(check.unread, [`WBTC (${BTC}): execution reverted`]);
  assert.equal(check.markets[1].fundingIncreaseFactorPerSecond, null);
  assert.equal(check.markets[1].fundingModeled, null);
  assert.match(
    gmxFundingMissingMessage(check),
    /Could not read GMX's funding configuration/,
  );
});

test("anvil stops on a missing funding config; the never-reset external chain only warns", () => {
  const unmodeled = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: 0n },
  ]);
  const unread = gmxFundingCheck([
    { base: "WETH", market: ETH, error: "execution reverted" },
  ]);
  const modeled = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: PATCHED },
  ]);
  // backtest / sim:realtime: the chain is rebuilt from a dump, so re-baking is the fix.
  assert.equal(gmxFundingEnforcement(unmodeled, "anvil"), "fail");
  assert.equal(gmxFundingEnforcement(unread, "anvil"), "fail");
  // Practice devnet: nothing to re-bake mid-period, and stopping would end the period.
  assert.equal(gmxFundingEnforcement(unmodeled, "external"), "warn");
  assert.equal(gmxFundingEnforcement(unread, "external"), "warn");
  // A deployment that models funding passes in both.
  assert.equal(gmxFundingEnforcement(modeled, "anvil"), "pass");
  assert.equal(gmxFundingEnforcement(modeled, "external"), "pass");
});

test("the external-chain message says it continues and names the fix for the next deployment", () => {
  const check = gmxFundingCheck([
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: 0n },
  ]);
  const external = gmxFundingMissingMessage(check, "external");
  assert.match(external, /GMX funding is not modeled on this deployment/);
  assert.match(external, /Continuing anyway/);
  assert.match(external, /never reset/);
  assert.match(external, /npm run deploy -- --keep-fresh/);
  assert.match(external, /gen:local-constants/);
  // Re-baking a state dump is not a fix for a chain that is not loaded from one.
  assert.doesNotMatch(external, /gen:state-dump/);
  // The anvil message (the default) keeps the re-bake instruction and does not claim to continue.
  const anvil = gmxFundingMissingMessage(check);
  assert.equal(anvil, gmxFundingMissingMessage(check, "anvil"));
  assert.match(anvil, /gen:state-dump/);
  assert.doesNotMatch(anvil, /Continuing anyway/);
});

test("the reader asks the DataStore for gmxKeys' increase-factor key of every market", async () => {
  const calls: Array<{ address: Address; args: readonly unknown[] }> = [];
  const client = {
    readContract: async (req: { address: Address; args: readonly unknown[] }) => {
      calls.push(req);
      if (req.args[0] === gmxFundingIncreaseFactorKey(BTC))
        throw new Error("execution reverted\nmore detail");
      return PATCHED;
    },
  };
  const reads = await readGmxFundingConfig(client as never, {
    WETH: ETH,
    WBTC: BTC,
  });
  assert.deepEqual(
    calls.map((c) => [c.address, c.args[0]]),
    [
      [GMX.DataStore, gmxFundingIncreaseFactorKey(ETH)],
      [GMX.DataStore, gmxFundingIncreaseFactorKey(BTC)],
    ],
  );
  assert.deepEqual(reads, [
    { base: "WETH", market: ETH, fundingIncreaseFactorPerSecond: PATCHED },
    { base: "WBTC", market: BTC, error: "execution reverted" },
  ]);
});
