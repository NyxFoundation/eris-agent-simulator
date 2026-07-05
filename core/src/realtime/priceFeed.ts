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
