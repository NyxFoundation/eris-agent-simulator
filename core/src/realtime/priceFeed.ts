// fair price のオンチェーン配布（ADR 0006 §3）の**書込側**（環境専用）。
// abi・スケール変換・読取（readFairPrice / readFairPriceFor）は sdk/src/priceFeed.ts（agent と共有）。
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
// 環境 setup で admin 鍵からデプロイ（owner=admin。agent は書き込めない）。
export async function deployPriceFeed(
  ctx: SimContext,
  initialPrice: number,
): Promise<Address> {
  return deployContract(ctx, "PriceFeed", [toPriceFeedAnswer(initialPrice)]);
}

// 単純な setter の固定 gas。明示して estimateGas（EVM 実行待ち）を省く。
const SETTER_GAS = 300_000n;

// 毎ブロックの fair price 書込（mempool submit。oracle と同じく agent 上限超の fee で先頭に置く）。
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

// PriceFeed.sol のストレージ slot。`address public immutable owner` は immutable のため
// バイトコードに格納され slot を消費しない → `int256 private _answer` = slot 0、
// `uint256 private _updatedAtBlock` = slot 1（`uint8 public constant decimals` も slot を消費しない）。
const ANSWER_SLOT = `0x${"0".repeat(64)}` as Hex;
const UPDATED_AT_BLOCK_SLOT = `0x${"0".repeat(63)}1` as Hex;

// ADR 0011 §1: fair price を mempool tx でなく PriceFeed の storage へ直接書く（cheatcode）。
// 価格は block 境界で storage に在るため block 内に env の price tx が無く、agent が
// front-run する対象が機構的に消える（priority-fee 上限に依存しない順序保証）。価格配布は env
// 機構であり agent 動作ではないため cheatcode 利用は現実性を毀損しない。agent の読み口
// （readFairPrice = latestAnswer）は不変なので体験・submission 互換は変わらない。
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
// ADR 0013: 追加 base（WBTC 等）の価格配布。WETH は上の WETH 専用 API を使い続ける。
// ---------------------------------------------------------------------------

// 追加 base の mempool 書込（setPriceFor）。WETH は updatePriceFeedMempool を使う。
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

// _answers(slot 2) / _answerUpdatedAtBlock(slot 3) の mapping 要素 slot = keccak256(token ++ mapSlot)。
function answerSlotFor(token: Address, mapSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [token, mapSlot],
    ),
  );
}

// ADR 0011 §1 と同様の storage 直書きを追加 base にも適用（mapping slot 2/3）。
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

