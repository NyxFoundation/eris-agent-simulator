// fair price のオンチェーン配布（ADR 0006 §3）の**読取側**契約。
// 環境が PriceFeed コントラクトをデプロイし毎ブロック fair price を書き込む（書込側は
// core/src/realtime/priceFeed.ts）。agent は ERIS_PRICE_FEED_ADDRESS を受け取り、この
// readFairPrice / readFairPriceFor で読む（書込 tx は次ブロック着弾なので情報は 1 ブロック
// 遅れる。全 agent に等しく作用するため公平性は保たれる — ADR 0006 §3 に明記済みの仕様）。
import type { Address, PublicClient } from "viem";

export const priceFeedAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [{ name: "answer", type: "int256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "latestAnswer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  // ADR 0013: 追加 base（WBTC 等）の per-asset 価格。WETH は上の setPrice/latestAnswer を使う。
  {
    type: "function",
    name: "setPriceFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "answer", type: "int256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "answerOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "int256" }],
  },
] as const;

const PRICE_DECIMALS = 1e8; // USD 8 桁固定小数（Chainlink/Aave と同じ慣習）

export function toPriceFeedAnswer(price: number): bigint {
  return BigInt(Math.round(price * PRICE_DECIMALS));
}

export function fromPriceFeedAnswer(answer: bigint): number {
  return Number(answer) / PRICE_DECIMALS;
}

// agent / 再構成が読む fair price。blockNumber 指定で歴史ブロック断面も読める（ADR 0006 §4）。
export async function readFairPrice(
  publicClient: PublicClient,
  address: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "latestAnswer",
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}

// 追加 base の fair price を読む（answerOf）。WETH は readFairPrice(latestAnswer)。
export async function readFairPriceFor(
  publicClient: PublicClient,
  address: Address,
  token: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "answerOf",
    args: [token],
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}
