// GMX liquidation keeper (PR #233). The environment's keeper used to execute orders only, so no
// position was ever liquidated: a 20x bet through a crash survived to the bell. The scan reads every
// open position from DataStore's POSITION_LIST and asks the Reader whether it is liquidatable at
// the fair prices the order keeper hands the oracle.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { gmxLiquidatablePositions } from "@eris/sdk/protocols/gmx.js";
import { GMX_MARKETS, TOKENS } from "@eris/sdk/constants.js";

const MARKET = GMX_MARKETS.ETH_USD;
const marketProps = {
  marketToken: MARKET,
  indexToken: TOKENS.WETH.address,
  longToken: TOKENS.WETH.address,
  shortToken: TOKENS.USDC.address,
};
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const account = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;
const position = (n: number, sizeInUsd: bigint, isLong = true) => ({
  addresses: {
    account: account(n),
    market: MARKET,
    collateralToken: TOKENS.USDC.address,
  },
  numbers: { sizeInUsd, sizeInTokens: 0n, collateralAmount: 0n },
  flags: { isLong },
});

// A fake client that answers the scan's reads and records what it was asked.
function client(
  positions: unknown[],
  liquidatable: boolean[],
  seen: { checks: unknown[][] },
) {
  return {
    async readContract(req: { functionName: string }) {
      if (req.functionName === "getBytes32Count")
        return BigInt(positions.length);
      if (req.functionName === "getBytes32ValuesAt")
        return positions.map((_, i) => key(i + 1));
      throw new Error(`unexpected ${req.functionName}`);
    },
    async multicall(req: {
      contracts: Array<{ functionName: string; args: unknown[] }>;
    }) {
      const fn = req.contracts[0]?.functionName;
      if (fn === "getPosition")
        return positions.map((p) => ({ status: "success", result: p }));
      if (fn === "getMarket")
        return req.contracts.map(() => ({
          status: "success",
          result: marketProps,
        }));
      if (fn === "isPositionLiquidatable") {
        seen.checks = req.contracts.map((c) => c.args);
        return req.contracts.map((c) => {
          const k = c.args[2] as Hex;
          const i = Number(BigInt(k)) - 1;
          return {
            status: "success",
            result: [liquidatable[i], liquidatable[i] ? "min collateral" : "", {}],
          };
        });
      }
      throw new Error(`unexpected ${fn}`);
    },
  } as never;
}

test("the scan returns the positions the reader calls liquidatable, any account's", async () => {
  const seen = { checks: [] as unknown[][] };
  const found = await gmxLiquidatablePositions(
    client(
      [position(1, 10n ** 34n), position(2, 10n ** 34n, false), position(3, 10n ** 34n)],
      [false, true, true],
      seen,
    ),
    { WETH: 3000 },
  );
  assert.deepEqual(
    found.map((p) => [p.account, p.isLong, p.market]),
    [
      [account(2), false, MARKET],
      [account(3), true, MARKET],
    ],
  );
  // Checked for liquidation (not just a decrease) at the fair price, WETH at $3,000.
  const args = seen.checks[0];
  assert.equal(args[5], true);
  assert.equal(args[6], true);
  const prices = args[4] as { indexTokenPrice: { min: bigint; max: bigint } };
  assert.equal(prices.indexTokenPrice.min, prices.indexTokenPrice.max);
  assert.equal(prices.indexTokenPrice.min, 3000n * 10n ** 12n);
});

test("a closed position (size 0) is not checked", async () => {
  const seen = { checks: [] as unknown[][] };
  const found = await gmxLiquidatablePositions(
    client([position(1, 0n), position(2, 10n ** 34n)], [true, false], seen),
    { WETH: 3000 },
  );
  assert.deepEqual(found, []);
  assert.equal(seen.checks.length, 1);
});

test("no fair price for the market's tokens means no check, not a liquidation at a guess", async () => {
  const seen = { checks: [] as unknown[][] };
  const found = await gmxLiquidatablePositions(
    client([position(1, 10n ** 34n)], [true], seen),
    {},
  );
  assert.deepEqual(found, []);
  assert.equal(seen.checks.length, 0);
});
