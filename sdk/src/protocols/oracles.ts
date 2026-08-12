import { encodeFunctionData, type Address, type Hex } from "viem";
import { LST, TOKENS } from "../constants.js";
import { tokenInfo } from "../markets.js";
import {
  bigintToStorageWord,
  sendAndMine,
  sendNoMine,
  setStorageAt,
} from "../chain.js";
import { lstVaultAbi } from "../abis.js";
import { marketPricedStables, readStablePrices } from "../stables.js";
import type { SimContext } from "./types.js";
import { mockAggregatorAbi, toAavePrice } from "./aave.js";

// Aave's price for the LST, when it is listed as collateral (issue #38 phase 3).
//
// An LST is not worth what its underlying is worth: it is worth WETH x the vault's redemption
// rate, which rises with yield and drops with a slash. Aave has no idea about any of that, so the
// price is derived here and written through the same three paths as every other oracle -- which
// also means it inherits the same one-block lag. That lag is what turns a slash into a liquidation
// cascade: the cut lands on the vault, the oracle follows a block later, and positions that were
// healthy become liquidatable together.
//
// Returns null when the LST is not listed, has no aggregator, or the rate cannot be read -- in
// every case leaving the existing price alone rather than writing a wrong one.
async function lstAaveAggregator(
  ctx: SimContext,
  fairPrice: number,
): Promise<{ aggregator: Address; aavePrice: bigint } | null> {
  if (!LST?.aaveAToken) return null;
  const aggregator = ctx.oracle.aaveAggregators[LST.lstToken.toLowerCase()];
  if (!aggregator) return null;
  if (!Number.isFinite(fairPrice) || fairPrice <= 0) return null;
  let rate: bigint;
  try {
    rate = (await ctx.publicClient.readContract({
      address: LST.vault,
      abi: lstVaultAbi,
      functionName: "stEthPerToken",
    })) as bigint;
  } catch {
    return null;
  }
  const priceUsd = (fairPrice * Number(rate)) / 1e18;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  return { aggregator, aavePrice: toAavePrice(priceUsd) };
}

// ADR 0013: enumerate additional bases beyond WETH/USDC that have an Aave mock aggregator registered.
// On the default fork ctx.fairPrices is unset or WETH-only, so this returns an empty array, byte-identical to before.
// Skip bases with no aggregator / a non-finite fair price (guard against writing 0 to aave).
function extraAaveAggregators(
  ctx: SimContext,
): Array<{ aggregator: Address; aavePrice: bigint }> {
  const fairPrices = ctx.fairPrices;
  if (!fairPrices) return [];
  const out: Array<{ aggregator: Address; aavePrice: bigint }> = [];
  for (const [base, price] of Object.entries(fairPrices)) {
    if (base === "WETH" || base === "USDC") continue; // handled by the existing path
    if (!Number.isFinite(price) || price <= 0) continue;
    const addr = tokenInfo(base).address.toLowerCase();
    const aggregator = ctx.oracle.aaveAggregators[addr];
    if (!aggregator) continue; // no aave reserve for this base
    out.push({ aggregator, aavePrice: toAavePrice(price) });
  }
  return out;
}

// Issue #27 (c): the Aave price of a *market-priced* stable. Aave marks every stable at $1 from a
// mock aggregator, which is the same assertion the scorer stopped making -- so a stable used as
// collateral would keep its full borrowing power all the way through a depeg while the wallet's
// copy of the same token was marked down. Reading it off the same probe the scorer uses keeps the
// two consistent.
//
// Empty unless a market-priced stable is actually listed as an Aave reserve. Nothing is today
// (aaveReserveSymbols() is the bases plus USDC plus the LST), so this costs one pool read and
// nothing else; it activates the day one is listed rather than being discovered then.
async function stableAaveAggregators(
  ctx: SimContext,
): Promise<Array<{ aggregator: Address; aavePrice: bigint }>> {
  const markets = marketPricedStables();
  const listed = markets.filter(
    (m) => ctx.oracle.aaveAggregators[m.token.toLowerCase()],
  );
  if (listed.length === 0) return [];
  const prices = await readStablePrices(
    ctx.publicClient,
    listed.map((m) => m.token),
  );
  const out: Array<{ aggregator: Address; aavePrice: bigint }> = [];
  for (const m of listed) {
    const price = prices.byToken[m.token.toLowerCase()];
    if (!Number.isFinite(price) || !(price > 0)) continue;
    out.push({
      aggregator: ctx.oracle.aaveAggregators[m.token.toLowerCase()],
      aavePrice: toAavePrice(price),
    });
  }
  return out;
}

// At the start of each round, make the GMX/Aave mock prices track fairPrice.
// Price updates are done with coordinator-privileged txs (in a separate block from the competition block).
export async function updateOracles(
  ctx: SimContext,
  fairPrice: number,
): Promise<boolean> {
  let wrote = false;

  // Aave: MockAggregator.setAnswer (USD, 8 decimals)
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: wethAgg,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [toAavePrice(fairPrice)],
        }),
      },
    );
    wrote = true;
  }
  if (usdcAgg) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: usdcAgg,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [toAavePrice(1)],
        }),
      },
    );
    wrote = true;
  }

  // ADR 0013: also track additional bases' (WBTC etc.) Aave aggregators. Empty loop on the default fork.
  // Issue #27 (c): and any market-priced stable Aave lists, at what its pool says rather than $1.
  for (const { aggregator, aavePrice } of [
    ...extraAaveAggregators(ctx),
    ...(await stableAaveAggregators(ctx)),
  ]) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: aggregator,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [aavePrice],
        }),
      },
    );
    wrote = true;
  }

  // Issue #38 phase 3: the LST's own price, WETH x the vault's redemption rate.
  const lstAgg = await lstAaveAggregator(ctx, fairPrice);
  if (lstAgg) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: lstAgg.aggregator,
        data: encodeFunctionData({
          abi: mockAggregatorAbi,
          functionName: "setAnswer",
          args: [lstAgg.aavePrice],
        }),
      },
    );
    wrote = true;
  }

  // GMX: MockOracleProvider.setPrice (extended by the gmx module in Phase 5)
  if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
    await ctx.updateGmxOracle(ctx, fairPrice);
    wrote = true;
  }

  return wrote;
}

// Fixed gas for a simple setter. Set it explicitly to skip estimateGas (which waits on EVM execution).
const SETTER_GAS = 300_000n;

// For realtime mode: submit oracle updates to the mempool without mining. Under interval mining they
// are included in the next block. Pass a priorityFeeWei above the agent cap so that, via --order fees,
// the oracle update comes before the agents (near txIndex 0). Returns the submitted tx hashes.
export async function updateOraclesMempool(
  ctx: SimContext,
  fairPrice: number,
  priorityFeeWei: bigint,
): Promise<Hex[]> {
  const hashes: Hex[] = [];
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: wethAgg,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [toAavePrice(fairPrice)],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  if (usdcAgg) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: usdcAgg,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [toAavePrice(1)],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  // ADR 0013: also update additional bases' (WBTC etc.) Aave aggregators via the mempool. Empty loop on the default fork.
  // Issue #27 (c): and any market-priced stable Aave lists.
  for (const { aggregator, aavePrice } of [
    ...extraAaveAggregators(ctx),
    ...(await stableAaveAggregators(ctx)),
  ]) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: aggregator,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [aavePrice],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  // Issue #38 phase 3: the LST's own price, WETH x the vault's redemption rate.
  const lstAgg = await lstAaveAggregator(ctx, fairPrice);
  if (lstAgg) {
    hashes.push(
      await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: lstAgg.aggregator,
          data: encodeFunctionData({
            abi: mockAggregatorAbi,
            functionName: "setAnswer",
            args: [lstAgg.aavePrice],
          }),
          gas: SETTER_GAS,
        },
        priorityFeeWei,
      ),
    );
  }
  if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
    // GMX submits two txs internally (WETH/USDC). The hashes can't be tracked but they land in the mempool.
    await ctx.updateGmxOracle(ctx, fairPrice, { noMine: true, priorityFeeWei });
  }
  return hashes;
}

// MockAggregator.sol's storage slot. `int256 private _answer` = slot 0
// (`uint8 public constant decimals` consumes no slot, and _roundId/_updatedAt are slots 1/2, but
// AaveOracle.getAssetPrice only reads latestAnswer(), so writing the answer directly is enough).
const AGG_ANSWER_SLOT = `0x${"0".repeat(64)}` as Hex;

// ADR 0011 §1: finalize the Aave WETH/USDC oracle prices by writing storage directly instead of via a mempool tx.
// Like PriceFeed, it exists at the block boundary, so there is nothing to front-run and it does not depend on the priority-fee cap.
// Used only in the economic profile (economicGas). No-op if the aggregator is not deployed (aave disabled).
export async function writeAaveOraclesStorage(
  ctx: SimContext,
  fairPrice: number,
): Promise<void> {
  const wethAgg = ctx.oracle.aaveAggregators[TOKENS.WETH.address.toLowerCase()];
  const usdcAgg = ctx.oracle.aaveAggregators[TOKENS.USDC.address.toLowerCase()];
  if (wethAgg) {
    await setStorageAt(
      ctx.publicClient,
      wethAgg,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(toAavePrice(fairPrice)),
    );
  }
  if (usdcAgg) {
    await setStorageAt(
      ctx.publicClient,
      usdcAgg,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(toAavePrice(1)),
    );
  }
  // ADR 0013: also write additional bases' (WBTC etc.) Aave aggregators to storage directly. Empty loop on the default fork.
  // Issue #27 (c): and any market-priced stable Aave lists.
  for (const { aggregator, aavePrice } of [
    ...extraAaveAggregators(ctx),
    ...(await stableAaveAggregators(ctx)),
  ]) {
    await setStorageAt(
      ctx.publicClient,
      aggregator,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(aavePrice),
    );
  }
  // Issue #38 phase 3: the LST's own price, WETH x the vault's redemption rate.
  const lstAgg = await lstAaveAggregator(ctx, fairPrice);
  if (lstAgg) {
    await setStorageAt(
      ctx.publicClient,
      lstAgg.aggregator,
      AGG_ANSWER_SLOT,
      bigintToStorageWord(lstAgg.aavePrice),
    );
  }
}
