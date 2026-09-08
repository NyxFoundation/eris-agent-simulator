// The **write side** of on-chain fair price distribution (ADR 0006 §3), environment-only.
// The abi, scale conversion, and reads (readFairPrice / readFairPriceFor) live in sdk/src/priceFeed.ts (shared with agents).
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  bigintToStorageWord,
  sendAndMine,
  sendNoMine,
  setStorageAt,
} from "@eris/sdk/chain.js";
import { deployContract } from "@eris/sdk/protocols/deploy.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import { priceFeedAbi, toPriceFeedAnswer } from "@eris/sdk/priceFeed.js";

export {
  priceFeedAbi,
  toPriceFeedAnswer,
  fromPriceFeedAnswer,
  readFairPrice,
  readFairPriceFor,
} from "@eris/sdk/priceFeed.js";
// Deployed from the admin key during environment setup (owner=admin; agents cannot write).
export async function deployPriceFeed(
  ctx: SimContext,
  initialPrice: number,
): Promise<Address> {
  return deployContract(ctx, "PriceFeed", [toPriceFeedAnswer(initialPrice)]);
}

// Fixed gas for a simple setter. Specifying it explicitly skips estimateGas (which waits on EVM execution).
const SETTER_GAS = 300_000n;

// ---------------------------------------------------------------------------
// Setup-time writes: every base's opening fair is on the feed before the first boundary is marked
// (issue #94, decided 2026-09-07 from #92's scorer row).
//
// The constructor carries WETH's opening fair, and every other base used to get its first value
// from the per-block oracle write -- which lands one block *after* the first epoch boundary is
// marked. Measured (calm, 60 blocks, 2026-09-07): noop's V_0 was 348,996 and V_K 365,839 on the
// same holdings; the difference was 0.4 WBTC marked at 0 and then at ~60k. Every agent got the
// same +24k in P, so T was untouched, but V_0 was short by the WBTC leg, noop's netPnlUsdc was
// not the 0 the guide promises, `scoring_unpriced_holdings` listed spot WBTC for everyone at the
// first boundary, and every value chart opened on a step.
//
// Ordinary mined setter transactions from the admin key: the same mechanism on anvil and on an
// external chain (the storage write is a cheatcode, and updateOracles takes the same route for
// Aave in external mode). Sent before any agent process exists, so nothing can front-run them.
// ---------------------------------------------------------------------------

// WETH's opening fair, re-written after a prewarm moved the pools (the constructor value predates it).
export async function setPriceFeedOpening(
  ctx: SimContext,
  address: Address,
  fairPrice: number,
): Promise<Hex> {
  return sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: address,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPrice",
        args: [toPriceFeedAnswer(fairPrice)],
      }),
    },
  );
}

// An extra base's opening fair (setPriceFor), mined. The per-block path is updatePriceFeedForMempool.
export async function setPriceFeedOpeningFor(
  ctx: SimContext,
  address: Address,
  token: Address,
  price: number,
): Promise<Hex> {
  return sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: address,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPriceFor",
        args: [token, toPriceFeedAnswer(price)],
      }),
    },
  );
}

// Per-block fair price write (mempool submit; like the oracle, placed first with a fee above the agent cap).
export async function updatePriceFeedMempool(
  ctx: SimContext,
  address: Address,
  fairPrice: number,
  priorityFeeWei: bigint,
): Promise<Hex> {
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: address,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPrice",
        args: [toPriceFeedAnswer(fairPrice)],
      }),
      gas: SETTER_GAS,
    },
    priorityFeeWei,
  );
}

// Storage slots of PriceFeed.sol. `address public immutable owner`, being immutable, is stored in
// bytecode and consumes no slot -> `int256 private _answer` = slot 0,
// `uint256 private _updatedAtBlock` = slot 1 (`uint8 public constant decimals` also consumes no slot).
const ANSWER_SLOT = `0x${"0".repeat(64)}` as Hex;
const UPDATED_AT_BLOCK_SLOT = `0x${"0".repeat(63)}1` as Hex;

// ADR 0011 §1: write the fair price directly into PriceFeed storage instead of a mempool tx (cheatcode).
// Since the price is in storage at the block boundary, there is no env price tx inside the block, so the
// target an agent would front-run mechanically disappears (ordering guarantee independent of the priority-fee cap).
// Price distribution is an env mechanism, not an agent action, so using a cheatcode does not compromise realism.
// The agent's read path (readFairPrice = latestAnswer) is unchanged, so the experience and submission compatibility stay the same.
export async function writePriceFeedStorage(
  publicClient: PublicClient,
  address: Address,
  fairPrice: number,
  blockNumber: bigint,
): Promise<void> {
  await setStorageAt(
    publicClient,
    address,
    ANSWER_SLOT,
    bigintToStorageWord(toPriceFeedAnswer(fairPrice)),
  );
  await setStorageAt(
    publicClient,
    address,
    UPDATED_AT_BLOCK_SLOT,
    bigintToStorageWord(blockNumber),
  );
}

// ---------------------------------------------------------------------------
// ADR 0013: price distribution for extra bases (WBTC etc.). WETH keeps using the WETH-specific API above.
// ---------------------------------------------------------------------------

// Mempool write for an extra base (setPriceFor). WETH uses updatePriceFeedMempool.
export async function updatePriceFeedForMempool(
  ctx: SimContext,
  address: Address,
  token: Address,
  price: number,
  priorityFeeWei: bigint,
): Promise<Hex> {
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: address,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPriceFor",
        args: [token, toPriceFeedAnswer(price)],
      }),
      gas: SETTER_GAS,
    },
    priorityFeeWei,
  );
}

// Mapping element slot of _answers(slot 2) / _answerUpdatedAtBlock(slot 3) = keccak256(token ++ mapSlot).
function answerSlotFor(token: Address, mapSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [token, mapSlot],
    ),
  );
}

// Apply the same direct storage write as ADR 0011 §1 to extra bases as well (mapping slots 2/3).
export async function writePriceFeedStorageFor(
  publicClient: PublicClient,
  address: Address,
  token: Address,
  price: number,
  blockNumber: bigint,
): Promise<void> {
  await setStorageAt(
    publicClient,
    address,
    answerSlotFor(token, 2n),
    bigintToStorageWord(toPriceFeedAnswer(price)),
  );
  await setStorageAt(
    publicClient,
    address,
    answerSlotFor(token, 3n),
    bigintToStorageWord(blockNumber),
  );
}
