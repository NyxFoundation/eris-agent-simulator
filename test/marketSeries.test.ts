// Pure pieces of the post-run market series reconstruction (issue #63 Phase 2).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  gmxOpenInterestKey,
  summarizeTransfers,
} from "../core/src/realtime/marketSeries.js";

const AGENT = "0x00000000000000000000000000000000000a9e17" as Address;
const OTHER = "0x000000000000000000000000000000000000beef" as Address;
const UNKNOWN_TOKEN = "0x00000000000000000000000000000000000fa11" as Address;

const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const FAIR = { WETH: 3000 };

const weth = (units: number) => BigInt(Math.round(units * 1e6)) * 10n ** 12n;
const usdc = (units: number) => BigInt(Math.round(units * 1e6));

test("gmxOpenInterestKey matches the Keys.sol derivation", () => {
  // Expected values computed independently with `cast keccak` / `cast abi-encode`
  // over deployer/vendor/gmx-src/contracts/data/Keys.sol's formula.
  assert.equal(
    gmxOpenInterestKey(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      true,
    ),
    "0xe9b069bb2833eb4c6757fe3e2aec8f60b75f0f7a3b89a787f90542c579dd5e0b",
  );
});

test("summarizeTransfers: a sell swap reports side/base and the larger leg in USD", () => {
  const notional = summarizeTransfers({
    sender: AGENT,
    transfers: [
      { token: WETH, from: AGENT, to: OTHER, value: weth(2) },
      { token: USDC, from: OTHER, to: AGENT, value: usdc(5940) },
    ],
    fair: FAIR,
  });
  assert.ok(notional);
  assert.equal(notional.base, "WETH");
  assert.equal(notional.side, "sell");
  // out = 2 WETH * $3000 = $6000, in = $5940 -> max is the outbound leg
  assert.equal(notional.usd, 6000);
  assert.equal(notional.amount, "2.00 WETH");
});

test("summarizeTransfers: a buy swap flips the side", () => {
  const notional = summarizeTransfers({
    sender: AGENT,
    transfers: [
      { token: USDC, from: AGENT, to: OTHER, value: usdc(3030) },
      { token: WETH, from: OTHER, to: AGENT, value: weth(1) },
    ],
    fair: FAIR,
  });
  assert.ok(notional);
  assert.equal(notional.side, "buy");
  assert.equal(notional.base, "WETH");
  assert.equal(notional.usd, 3030);
});

test("summarizeTransfers: unknown tokens are counted, not silently priced", () => {
  let unknown = 0;
  // Aave-supply shape: WETH out to the pool, an aToken (not in the registry) minted back.
  const notional = summarizeTransfers({
    sender: AGENT,
    transfers: [
      { token: WETH, from: AGENT, to: OTHER, value: weth(3) },
      { token: UNKNOWN_TOKEN, from: OTHER, to: AGENT, value: weth(3) },
    ],
    fair: FAIR,
    onUnknownToken: () => {
      unknown++;
    },
  });
  assert.ok(notional);
  assert.equal(unknown, 1);
  assert.equal(notional.usd, 9000); // only the priceable WETH leg
  // one-sided base flow still names the base
  assert.equal(notional.base, "WETH");
  assert.equal(notional.side, "sell");
});

test("summarizeTransfers: transfers not involving the sender produce nothing", () => {
  const notional = summarizeTransfers({
    sender: AGENT,
    transfers: [{ token: WETH, from: OTHER, to: OTHER, value: weth(10) }],
    fair: FAIR,
  });
  assert.equal(notional, undefined);
});

test("summarizeTransfers: a base with no fair price is reported unknown, not $0", () => {
  let unknown = 0;
  const notional = summarizeTransfers({
    sender: AGENT,
    transfers: [{ token: WETH, from: AGENT, to: OTHER, value: weth(1) }],
    fair: {},
    onUnknownToken: () => {
      unknown++;
    },
  });
  assert.equal(notional, undefined);
  assert.equal(unknown, 1);
});
