/**
 * マルチアセット agent 用の observation 正規化ヘルパ（ADR 0013）。
 *
 * WETH は従来どおりトップレベル（protocols.uniswap.pool / protocols.balancer /
 * protocols.curve）に、追加 base（WBTC 等）は protocols.*.markets["<base>/USDC"] に入る。
 * この差異を吸収し、全 active base を「base / fair / venue 価格群 / base 在庫」の同じ形へ
 * 正規化して返す。これにより agent ロジックは base を意識せず全 market を一様に走査できる
 * （個別資産対応ではなく複数資産対応の設計へ移行するための土台）。
 *
 * base の集合は observation.fairPricesUsd のキーから導出する（coordinator/directShim が
 * 全 active base の fair price を載せる）。venue 価格が 1 つも無い base は除外する。
 */
import type { AgentObservation } from "@eris/sdk/types.js";

export type AgentProtocol = "uniswap" | "balancer" | "curve";

export type AgentVenue = {
  protocol: AgentProtocol;
  swapType: "swap" | "balancerSwap" | "curveSwap";
  // quote(USDC) per base。venue 間で比較可能な mid 相当に正規化済み（balancer/curve の
  // fee 込み見積りは fee 分を戻してある。marketViews 内のコメント参照）。
  price: number;
  // 取引手数料（bps）。cross-venue 裁定のラウンドトリップ採算判定に使う。uniswap は pool fee
  // （3000 pips = 30bps）を読む。balancer/curve は observation に fee が無いため既定 30bps。
  feeBps: number;
};

export type MarketView = {
  base: string; // "WETH" | "WBTC" | ...
  fair: number; // 当該 base の fair USD 価格
  venues: AgentVenue[];
  // base 在庫（base units, decimal string）。WETH は balances.wethWei、他は baseBalances[base]。
  baseBalanceWei: string;
  // base の decimals（WETH=18 / WBTC=8）。base 量 ⇔ USD/quote 換算に使う。
  baseDecimals: number;
  // base-input swap の per-round 上限（base units, decimal string）。"0" = 上限なし（balance bound）。
  maxSwapInBaseWei: string;
};

const QUOTE = "USDC";

const SWAP_TYPE: Record<AgentProtocol, AgentVenue["swapType"]> = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
};

function venuePrice(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): number | undefined {
  const p = obs.protocols ?? {};
  if (protocol === "uniswap") {
    if (base === "WETH") return p.uniswap?.pool?.priceUsdcPerWeth;
    return p.uniswap?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
  }
  const amm = protocol === "balancer" ? p.balancer : p.curve;
  if (base === "WETH") return amm?.priceUsdcPerWeth;
  return amm?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
}

// venue の取引手数料（bps）。uniswap は pool fee（pips, 3000=0.3%）→ /100 で bps。
// balancer/curve は observation に fee が無いため既定 30bps（保守的）。
function venueFeeBps(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): number {
  if (protocol !== "uniswap") return 30;
  const pool =
    base === "WETH"
      ? obs.protocols?.uniswap?.pool
      : obs.protocols?.uniswap?.markets?.[`${base}/${QUOTE}`];
  const fee = pool?.fee;
  return typeof fee === "number" && fee > 0 ? fee / 100 : 30;
}

// observation を base 非依存の market view 配列に正規化する。WETH を先頭に固定（決定論順序）。
export function marketViews(obs: AgentObservation): MarketView[] {
  const fairByBase = obs.fairPricesUsd ?? { WETH: obs.fairPriceUsdcPerWeth };
  const bases = Object.keys(fairByBase).sort((a, b) =>
    a === "WETH" ? -1 : b === "WETH" ? 1 : a < b ? -1 : 1,
  );
  const views: MarketView[] = [];
  for (const base of bases) {
    const fair = fairByBase[base];
    if (!(fair > 0)) continue;
    const venues: AgentVenue[] = [];
    for (const protocol of ["uniswap", "balancer", "curve"] as const) {
      const price = venuePrice(obs, base, protocol);
      if (typeof price === "number" && price > 0) {
        const feeBps = venueFeeBps(obs, base, protocol);
        // 観測価格の規約を mid に統一する。uniswap は slot0 の mid だが、balancer/curve の
        // 観測 price は「fee 込みの売り見積り」（quoter/query に probe を投げた executable
        // price）で、fee 分だけ系統的に安く見える（全プール均衡状態の実測: uniswap 3000.00 /
        // balancer 2990.97 / curve 2992.20）。この段差を放置すると (1) cheap/rich 判定が
        // 常に balancer/curve 側へ歪む、(2) 採算計算で fee を二重計上する（quoted に fee が
        // 織り込み済みなのに閾値でも fee を足す）— 見かけの spread を追って fee 負けする
        // 系統損の原因になる。fee 分を戻して mid 相当に正規化して比較する。
        const mid =
          protocol === "uniswap" ? price : price / (1 - feeBps / 10000);
        venues.push({
          protocol,
          swapType: SWAP_TYPE[protocol],
          price: mid,
          feeBps,
        });
      }
    }
    if (venues.length === 0) continue;
    const baseBalanceWei =
      base === "WETH"
        ? obs.balances.wethWei
        : (obs.baseBalances?.[base] ?? "0");
    const baseDecimals = obs.baseDecimals?.[base] ?? 18;
    const maxSwapInBaseWei =
      base === "WETH"
        ? obs.limits.maxWethInWei
        : (obs.limits.baseLimits?.[base]?.maxSwapInBaseWei ?? "0");
    views.push({
      base,
      fair,
      venues,
      baseBalanceWei,
      baseDecimals,
      maxSwapInBaseWei,
    });
  }
  return views;
}
