import { describe, it, expect, beforeAll } from "vitest";
import type { Address } from "viem";
import { accounts, publicClient, traderWallet } from "../src/clients.js";
import { balanceOf } from "../src/erc20.js";
import { gmxDeployment, getProto, sameAddr, ZERO } from "./support.js";
import {
  type GmxRegistry,
  deployMockOracleProvider,
  resolveKeeper,
  setupOracle,
  mintAndApprove,
  createDeposit,
  createIncreaseOrder,
  keeperExecute,
  getLongPosition,
} from "./gmx-e2e.js";

type Market = {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
};

const g = getProto<{
  Reader: Address;
  DataStore: Address;
  marketCount?: number;
  markets?: Market[];
}>("gmxV2");

describe.skipIf(!g)("GMX V2 (read-only)", () => {
  const readerAbi = () => gmxDeployment("Reader").abi;

  it("Reader.getMarkets matches the registry marketCount", async () => {
    const markets = (await publicClient.readContract({
      address: g!.Reader,
      abi: readerAbi(),
      functionName: "getMarkets",
      args: [g!.DataStore, 0n, 100n],
    })) as readonly Market[];
    expect(markets.length).toBeGreaterThan(0);
    if (typeof g!.marketCount === "number")
      expect(markets.length).toBe(g!.marketCount);
    // Every market's marketToken is non-zero
    for (const m of markets) expect(m.marketToken).not.toBe(ZERO);
  });

  it("recorded market is consistent with Reader.getMarket", async () => {
    if (!g!.markets?.length) return;
    const sample = g!.markets[0];
    const m = (await publicClient.readContract({
      address: g!.Reader,
      abi: readerAbi(),
      functionName: "getMarket",
      args: [g!.DataStore, sample.marketToken],
    })) as Market;
    expect(sameAddr(m.marketToken, sample.marketToken)).toBe(true);
    expect(sameAddr(m.longToken, sample.longToken)).toBe(true);
    expect(sameAddr(m.shortToken, sample.shortToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full E2E: GM liquidity deposit -> keeper execute -> openPosition -> keeper execute
// trader (index 2) creates, keeper (index 1) executes, prices controlled by MockOracleProvider.
// ---------------------------------------------------------------------------

const gx = getProto<GmxRegistry>("gmxV2");

// Pick a fully collateralized market where long==WETH / short==USDC
function pickWethUsdcMarket(reg: GmxRegistry | undefined): {
  market: GmxRegistry["markets"][number];
  weth: Address;
  usdc: Address;
} | null {
  if (!reg?.markets?.length || !reg.tokens?.WETH || !reg.tokens?.USDC)
    return null;
  const weth = reg.tokens.WETH;
  const usdc = reg.tokens.USDC;
  const market = reg.markets.find(
    (m) =>
      m.longToken.toLowerCase() === weth.toLowerCase() &&
      m.shortToken.toLowerCase() === usdc.toLowerCase(),
  );
  return market ? { market, weth, usdc } : null;
}

const picked = pickWethUsdcMarket(gx);

describe.skipIf(!picked)("GMX V2 full E2E (deposit -> openPosition)", () => {
  const reg = gx!;
  const { market, weth, usdc } = picked!;

  // GMX test tokens: WETH=18d, USDC=6d
  const LONG_DEPOSIT = 50n * 10n ** 18n; // 50 WETH
  const SHORT_DEPOSIT = 150_000n * 10n ** 6n; // 150,000 USDC
  const COLLATERAL = 1n * 10n ** 18n; // 1 WETH
  const SIZE_DELTA_USD = 3_000n * 10n ** 30n; // $3,000 (1x)

  let mock: Address;
  let keeper: Awaited<ReturnType<typeof resolveKeeper>>;

  beforeAll(async () => {
    mock = await deployMockOracleProvider();
    keeper = await resolveKeeper(reg);
    await setupOracle(reg, mock, {
      [weth]: { usd: 3000, decimals: 18 },
      [usdc]: { usd: 1, decimals: 6 },
    });
    // Fund the trader with deposit + collateral tokens and approve the Router.
    // The shared WETH9 has no mint, so fund it via wrap.
    await mintAndApprove(
      weth,
      accounts.trader,
      traderWallet,
      reg.Router,
      LONG_DEPOSIT + COLLATERAL,
      { wrap: true },
    );
    await mintAndApprove(
      usdc,
      accounts.trader,
      traderWallet,
      reg.Router,
      SHORT_DEPOSIT,
    );
  });

  it("GM liquidity deposit -> keeper execute mints GM tokens", async () => {
    const before = await balanceOf(market.marketToken, accounts.trader.address);
    const key = await createDeposit(reg, market, LONG_DEPOSIT, SHORT_DEPOSIT);
    await keeperExecute("deposit", keeper, reg.DepositHandler, key, mock, [
      weth,
      usdc,
    ]);
    const after = await balanceOf(market.marketToken, accounts.trader.address);
    expect(after).toBeGreaterThan(before); // GM tokens minted = liquidity provision succeeded
  });

  it("openPosition (long) -> keeper execute creates a position", async () => {
    const key = await createIncreaseOrder(
      reg,
      market,
      weth,
      COLLATERAL,
      SIZE_DELTA_USD,
      true,
    );
    await keeperExecute("order", keeper, reg.OrderHandler, key, mock, [
      weth,
      usdc,
    ]);
    const pos = await getLongPosition(reg, market.marketToken);
    expect(pos, "long position does not exist").toBeDefined();
    expect(pos!.numbers.sizeInUsd).toBeGreaterThan(0n);
    expect(pos!.numbers.collateralAmount).toBeGreaterThan(0n);
  });
});
