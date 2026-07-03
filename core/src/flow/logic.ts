// orderflow 生成の純粋ロジック。
//
// 以前は各 ProtocolAdapter.buildFlow に分散していたが、orderflow を独立プロセス
// (examples/flow/market-maker.ts) に切り出すため、RPC に触れない純粋関数として集約した。
// coordinator は flow ウォレットと tx 提出を引き続き所有し、bot は「どの注文を出すか」だけ決める。
//
// 決定論: bot は自前の Rng(flowSeed) を持ち、ここの関数を coordinator が渡す
// protocols 順（= enabledAdapters 順。既定は config.ALL_PROTOCOLS の
// uniswap, balancer, curve, gmx, aave で gmx が aave より前）で呼ぶ。
// 元の buildFlowIntents と RNG 消費順序を一致させるため、ロジックは旧 adapter から逐語移設している。
import type { Rng } from "@eris/sdk/rng.js";
import type { LeafAction, ProtocolId, TokenSymbol } from "@eris/sdk/types.js";
import type { FlowKind, FlowOrder } from "@eris/sdk/protocols/types.js";
import { tokenInfo } from "@eris/sdk/markets.js";

// 会計上の quote（USDC 相当）の decimals。base→quote 換算の桁差に使う。
const QUOTE_DECIMALS = tokenInfo("USDC").decimals;

const FLOW_SLIPPAGE_BPS = 100;

// coordinator が文字列で渡す flow 関連の上限値（bigint 復元後の形）。
export type FlowLimits = {
  uninformedFlowMaxWethWei: bigint;
  // 1 ブロック・1 venue あたりの uninformed flow 本数（既定 1）。>1 で複数の独立した
  // ランダムプッシュを各 venue へ流し、venue 間のズレを「自然発生」させる（ハイブリッド α）。
  uninformedFlowCountPerBlock: number;
  // uninformed 方向の持続ブロック数（既定 1）。>1 で venue 別 trend が cross-venue ズレを自然発生。
  uninformedFlowPersistBlocks: number;
  informedFlowMaxWethWei: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  // gmx flow を出すブロック確率（0..1、既定 0.5）。毎ブロック rng で判定し散発的に送る。
  gmxFlowActivityProb: number;
  // 発火ブロックで出す gmx 注文の最大本数（>=1、既定 1）。>1 で 1〜N 件をランダムにバースト。
  gmxFlowMaxBurst: number;
  aaveFlowMaxWethWei: bigint;
  maxAaveBorrowUsdcUnits: bigint;
  // aave flow を出すブロック確率（0..1、既定 0.5）。actor プールでは各 actor の毎ブロック行動確率。
  aaveFlowActivityProb: number;
  // ADR 0015 Notes / amm-challenge: informed flow の fee 境界（bps）。0=off（gap 線形）。
  informedArbFeeBps: number;
  // ADR 0015 Notes / amm-challenge の retail: uninformed 到着 Poisson(λ) / サイズ lognormal σ。
  // λ=0=off（固定本数 + 一様）。
  uninformedArrivalRate: number;
  uninformedSizeSigma: number;
  defaultPriorityFeeWei: bigint;
};

// FlowContext の wire 形（JSON。bigint は文字列）。
export type FlowContextWire = {
  round: number;
  fairPriceUsdcPerWeth: number;
  protocols: ProtocolId[];
  poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
  aaveReserves?: { wethSupplied: string; usdcBorrowed: string };
  // 複数アクターの aave 借り手プール（実時間の本路）。coordinator が各 actor ウォレットの reserve と
  // 残高を読んで渡す。指定時は buildAaveActorsFlow を使い、未指定なら単一の buildAaveFlow へフォールバック。
  aaveActors?: Array<{
    key: string;
    wethSupplied: string;
    usdcBorrowed: string;
    wethWei: string;
    usdcUnits: string;
  }>;
  flowBalances?: Record<string, { wethWei: string; usdcUnits: string }>;
  usdcOnlyFlow?: boolean;
  // ADR 0013 Phase 8: WETH 以外の base ごとの AMM flow。WETH-only run では未設定（既定 off）で、
  // この場合 buildFlowOrders は追加 base ループに入らず RNG を一切消費しない（byte 互換）。
  // coordinator が WBTC 等を有効化したときだけ埋まる。各 base の max が "0" なら early-continue。
  extraBases?: Array<{
    base: TokenSymbol;
    // protocol -> その venue の当該 base/USD pool 価格。揃わない venue は省略。
    poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>>;
    fairPriceUsd: number;
    // base 1e(decimals) 単位の AMM flow 上限。"0"/未設定で当該 base の flow は off（RNG 非消費）。
    uninformedFlowMaxBaseWei?: string;
    informedFlowMaxBaseWei?: string;
    balancerFlowMaxBaseWei?: string;
    curveFlowMaxBaseWei?: string;
  }>;
  limits: {
    uninformedFlowMaxWethWei: string;
    uninformedFlowCountPerBlock?: string;
    uninformedFlowPersistBlocks?: string;
    informedFlowMaxWethWei: string;
    balancerFlowMaxWethWei: string;
    curveFlowMaxWethWei: string;
    gmxFlowMaxSizeUsd: string;
    gmxFlowActivityProb?: string;
    gmxFlowMaxBurst?: string;
    aaveFlowMaxWethWei: string;
    maxAaveBorrowUsdcUnits: string;
    aaveFlowActivityProb?: string;
    // ADR 0015 Notes / amm-challenge: informed flow の fee 境界（bps）。未設定/"0"=off（byte 互換）。
    informedArbFeeBps?: string;
    // ADR 0015 Notes / amm-challenge の retail: uninformed 到着 Poisson(λ) / lognormal σ。未設定/"0"=off。
    uninformedArrivalRate?: string;
    uninformedSizeSigma?: string;
    defaultPriorityFeeWei: string;
  };
};

// bot が返す 1 注文（protocol タグ付き。coordinator が flow ウォレットを選ぶのに使う）。
export type FlowOrderOut = {
  protocol: ProtocolId;
  walletProtocol?: ProtocolId;
  // 明示的な flow ウォレット鍵（例 "aave:actor0"）。指定時は protocol/kind ではなくこの鍵で
  // ウォレットを選ぶ（複数アクターの aave 借り手プール用。flowOrdersToIntents が解決）。
  walletKey?: string;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: bigint;
};

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

type FlowBalance = { wethWei: bigint; usdcUnits: bigint };

// 確率文字列を [0,1] に丸める（未設定/非数は fallback）。activity gate に使う。
function clampProb(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function randomBigInt(
  rng: Rng,
  minInclusive: bigint,
  maxInclusive: bigint,
): bigint {
  const span = maxInclusive - minInclusive + 1n;
  return (
    minInclusive +
    (BigInt(Math.floor(rng.next() * 1_000_000)) * span) / 1_000_000n
  );
}

// bigint 上限を float の割合で縮尺する（ppm 精度）。lognormal サイズを wei へ落とすのに使う
// （uninformedMax が Number 安全整数を超えるため float×bigint は割合経由で計算する）。
function scaleFraction(cap: bigint, fraction: number): bigint {
  const ppm = BigInt(Math.max(0, Math.round(fraction * 1_000_000)));
  return (cap * ppm) / 1_000_000n;
}

// base amount(base decimals) を price(USDC/base) で quote units(USDC decimals) へ換算。
// flow の base 上限を quote 側の注文サイズにも適用し、両側を同じ強度ノブで制御するため。
// WETH 経路は (wethWei * round(price*100)) / (100 * 10^(18-6)) で従来式と byte 一致する。
function baseToQuoteUnits(
  baseAmount: bigint,
  base: TokenSymbol,
  price: number,
): bigint {
  const scale = 10n ** BigInt(tokenInfo(base).decimals - QUOTE_DECIMALS);
  return (baseAmount * BigInt(Math.round(price * 100))) / (100n * scale);
}

// 後方互換ラッパ（WETH base 専用）。既存呼び出し箇所の値を変えない。
function wethToUsdcUnits(wethWei: bigint, fairPrice: number): bigint {
  return baseToQuoteUnits(wethWei, "WETH", fairPrice);
}

function flowBalance(
  ctx: FlowContextWire,
  protocol: ProtocolId,
  kind: FlowKind,
): FlowBalance | null {
  const raw = ctx.flowBalances?.[`${protocol}:${kind}`];
  if (!raw) return null;
  return {
    wethWei: BigInt(raw.wethWei),
    usdcUnits: BigInt(raw.usdcUnits),
  };
}

function capUsdc(amount: bigint, balance: FlowBalance | null): bigint {
  if (!balance) return amount;
  return amount > balance.usdcUnits ? balance.usdcUnits : amount;
}

// AMM (uniswap/balancer/curve) の flow。uninformed ノイズ + informed(価格を fair に寄せる)。
// base 既定 WETH。base!=="WETH" のとき tokenIn に当該 base シンボルを使い、action.base を付けて
// adapter が WBTC/USDC market を解決できるようにする。WETH 経路は従来と byte 一致（base 未付与・
// tokenIn="WETH"・wethToUsdcUnits 同値・RNG 消費列不変）。
export function buildAmmFlow(
  rng: Rng,
  protocol: "uniswap" | "balancer" | "curve",
  poolPrice: number,
  fairPrice: number,
  uninformedMaxWethWei: bigint,
  informedMaxWethWei: bigint,
  defaultPriorityFeeWei: bigint,
  balances?: {
    uninformed?: FlowBalance | null;
    informed?: FlowBalance | null;
  },
  usdcOnlyFlow = false,
  base: TokenSymbol = "WETH",
  uninformedCount = 1,
  round = 0,
  persistBlocks = 1,
  // ADR 0015 Notes / amm-challenge: informed（裁定）flow を「fee バンドを超えた gap だけ」約定させる。
  // 0（既定）= 従来の gap 線形（無効。byte 互換）。>0 で fee-aware:
  //   - |gap| <= feeBps は no-arb 帯として見送り（arb が儲からないので market を過剰に締めない）
  //   - それ以上は fee バンドを超えた超過分だけを閉じる（残差 = fee。現実の裁定と同じ）
  // 私たちの venue は Uniswap v3 / weighted / crypto で純 CPMM ではないため、閉形式係数でなく
  // 「fee 境界の経済」だけを移植する（depth は既存の informedMax を代理に使う）。
  informedArbFeeBps = 0,
  // ADR 0015 Notes / amm-challenge の retail: uninformed 到着を Poisson(λ)・サイズを lognormal に。
  // arrivalRate=0（既定）= 従来の固定本数（uninformedCount）＋一様サイズ（byte 互換）。
  // >0 で 1 ブロックの本数を Poisson(λ)、各サイズを lognormal（平均 = uninformedMax×0.5、σ=sizeSigma）に。
  uninformedArrivalRate = 0,
  uninformedSizeSigma = 1,
): FlowOrder[] {
  const orders: FlowOrder[] = [];
  const swapType =
    protocol === "uniswap"
      ? "swap"
      : protocol === "balancer"
        ? "balancerSwap"
        : "curveSwap";
  // WETH 経路は action.base を付けない（旧出力と同形）。WBTC 等のみ base を付与する。
  const baseField = base === "WETH" ? {} : { base };

  // uninformed: pool を fair から押しのけて gap(裁定の餌)を作る。base/USDC とも同じ
  // base 相当のランダム量にして、uninformedMaxWethWei が両側を一様に制御する。
  // uninformedCount>1 のときは独立した複数プッシュ（向き/サイズ別）を流し、venue ごとに
  // 押し具合が変わる → cross-venue のズレが「自然発生」する（ハイブリッド α）。
  // count=1 では RNG 消費・出力が従来と byte 一致（後方互換）。
  // persistBlocks>1: venue ごとの uninformed 方向を persistBlocks ブロック持続させる
  // （round/persistBlocks を window とした決定論 trend）。連続同方向の偏り＝order-flow imbalance を
  // 模し、venue ごとに別 trend でズレが「自然発生」する（人工的な spread 注入なしの現実的 α）。
  // persistBlocks<=1 は rng.bool() を消費する従来挙動＝byte 互換。
  let trendTokenIn: TokenSymbol | null = null;
  if (persistBlocks > 1) {
    const window = Math.floor(round / persistBlocks);
    let h = ((window + 1) * 0x9e3779b1) >>> 0;
    for (let c = 0; c < protocol.length; c++)
      h = ((h ^ protocol.charCodeAt(c)) * 0x01000193) >>> 0;
    // USDC in=買い(価格↑) / base in=売り(価格↓)。venue×window で up/down が分かれ spread を作る。
    trendTokenIn = h % 2 === 0 ? "USDC" : base;
  }
  // Poisson モード（arrivalRate>0）: 1 ブロックの到着数を Poisson(λ) で引く（0 件のブロックも自然に出る）。
  // 従来モード（arrivalRate=0）: 固定本数 max(1, uninformedCount)。RNG 消費も従来どおり（byte 互換）。
  const arrivals =
    uninformedArrivalRate > 0
      ? rng.poisson(uninformedArrivalRate)
      : Math.max(1, uninformedCount);
  for (let u = 0; u < arrivals; u++) {
    let uninformedTokenIn: TokenSymbol =
      trendTokenIn ?? (rng.bool() ? base : "USDC");
    // Poisson モードはサイズを lognormal（裾が重い＝時々大口）。平均 = uninformedMax×0.5 で
    // 従来の一様（平均 ~52.5%）とほぼ同水準。外れ値は [2%, 300%] にクランプしてプールを壊さない。
    const uninformedWethEquiv =
      uninformedArrivalRate > 0
        ? scaleFraction(
            uninformedMaxWethWei,
            Math.min(
              3,
              Math.max(0.02, rng.lognormal(0.5, uninformedSizeSigma)),
            ),
          )
        : randomBigInt(rng, uninformedMaxWethWei / 20n, uninformedMaxWethWei);
    if (
      uninformedTokenIn === base &&
      (usdcOnlyFlow ||
        (balances?.uninformed &&
          balances.uninformed.wethWei < uninformedWethEquiv))
    ) {
      uninformedTokenIn = "USDC";
    }
    const uninformedAmount =
      uninformedTokenIn === base
        ? uninformedWethEquiv
        : capUsdc(
            baseToQuoteUnits(uninformedWethEquiv, base, fairPrice),
            balances?.uninformed ?? null,
          );
    const uninformedFee =
      defaultPriorityFeeWei + BigInt(rng.int(1, 50)) * 1_000_000n;
    if (uninformedAmount > 0n) {
      orders.push({
        kind: "uninformed",
        action: {
          type: swapType,
          tokenIn: uninformedTokenIn,
          amountIn: uninformedAmount.toString(),
          slippageBps: FLOW_SLIPPAGE_BPS,
          ...baseField,
        } as LeafAction,
        priorityFeeWei: uninformedFee,
      });
    }
  }

  // informed: pool 価格を fairPrice に寄せる（gap を閉じる側＝arb agent と競合する）。
  // 両側を informedMaxWethWei × gap で揃え、USDC 側も base 上限で制御する。
  // informedMaxWethWei を下げると flow bot が gap を潰さなくなり、arb の取り分が増える。
  // fee-aware（informedArbFeeBps>0）: |gap| が fee バンド以下なら裁定は無利なので informed を出さず、
  // 超えた分は fee バンドを超えた超過だけを閉じる（残差 = fee。amm-challenge の arb と同じ経済）。
  const rawDeviation = Math.abs(fairPrice / poolPrice - 1);
  if (informedArbFeeBps > 0 && rawDeviation * 10_000 <= informedArbFeeBps) {
    return orders; // no-arb 帯: market を過剰に締めない（arb agent の取り分を残す）
  }
  const effectiveDeviation =
    informedArbFeeBps > 0
      ? Math.max(0, rawDeviation - informedArbFeeBps / 10_000)
      : rawDeviation;
  let informedTokenIn: TokenSymbol = poolPrice < fairPrice ? "USDC" : base;
  const gap = Math.min(1, effectiveDeviation * 20);
  const informedWethEquiv =
    (informedMaxWethWei * BigInt(Math.max(1, Math.floor(gap * 100)))) / 100n;
  if (
    informedTokenIn === base &&
    (usdcOnlyFlow ||
      (balances?.informed && balances.informed.wethWei < informedWethEquiv))
  ) {
    // USDC-only runs start flow wallets with no base token. Buy base first so a later
    // sell-side informed flow can use the same wallet instead of reverting.
    informedTokenIn = "USDC";
  }
  const informedAmount =
    informedTokenIn === base
      ? informedWethEquiv
      : capUsdc(
          baseToQuoteUnits(informedWethEquiv, base, fairPrice),
          balances?.informed ?? null,
        );
  const informedFee =
    defaultPriorityFeeWei + BigInt(rng.int(50, 100)) * 1_000_000n;
  if (informedAmount > 0n) {
    orders.push({
      kind: "informed",
      action: {
        type: swapType,
        tokenIn: informedTokenIn,
        amountIn: informedAmount.toString(),
        slippageBps: FLOW_SLIPPAGE_BPS,
        ...baseField,
      } as LeafAction,
      priorityFeeWei: informedFee,
    });
  }

  return orders;
}

// GMX perp orderflow: 小口のロング/ショートを開いて約定ボリュームを作る（keeper が約定）。
export function buildGmxFlow(
  rng: Rng,
  gmxFlowMaxSizeUsd: bigint,
  defaultPriorityFeeWei: bigint,
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
  activityProb = 0.5,
  maxBurst = 1,
): FlowOrderOut[] {
  // activityProb の確率でのみこのブロックに送信（既定 0.5。config で散発度を調整）。
  if (rng.next() >= activityProb) return [];
  // 発火したブロックは 1〜maxBurst 件をランダムに出す（同一ウォレットの連番 nonce で同ブロック着弾）。
  // maxBurst<=1 は rng を追加消費せず従来の単発挙動と byte 一致。
  const burst = maxBurst <= 1 ? 1 : rng.int(1, maxBurst + 1);
  const orders: FlowOrderOut[] = [];
  for (let i = 0; i < burst; i++) {
    const isLong = rng.bool();
    // size は gmxFlowMaxSizeUsd の 1/100〜1/25 をランダム（基準 1/50。約 2x になるよう担保を size/2x）。
    const sizeUsd = randomBigInt(
      rng,
      gmxFlowMaxSizeUsd / 100n,
      gmxFlowMaxSizeUsd / 25n,
    );
    // collateral(WETH wei) ≈ (sizeUsd/2) を USD->WETH 換算。oraclePrices は使えないため概算 fairPrice 相当で割る
    const sizeUsdNum = Number(sizeUsd) / 1e30;
    const collateralWei = BigInt(
      Math.max(1, Math.floor(((sizeUsdNum / 2) * 1e18) / 2100)),
    );
    const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 60)) * 1_000_000n;
    if (
      balance &&
      balance.wethWei < collateralWei * (canPrepareWeth ? 2n : 1n)
    ) {
      if (!canPrepareWeth) break;
      const usdcIn = capUsdc(
        wethToUsdcUnits(collateralWei, fairPrice),
        balance,
      );
      if (usdcIn <= 0n) break;
      // WETH 在庫が無いブロックは担保用 USDC→WETH を 1 本だけ用意して打ち止め（次ブロックで建てる）。
      orders.push({
        protocol: "uniswap",
        walletProtocol: "gmx",
        kind: "uninformed",
        action: {
          type: "swap",
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: FLOW_SLIPPAGE_BPS,
        } as LeafAction,
        priorityFeeWei: fee,
      });
      break;
    }
    const action = {
      type: "gmxIncrease",
      isLong,
      collateral: "WETH",
      collateralAmount: collateralWei.toString(),
      sizeDeltaUsd: sizeUsd.toString(),
    } as unknown as LeafAction;
    orders.push({
      protocol: "gmx",
      kind: "uninformed",
      action,
      priorityFeeWei: fee,
    });
  }
  return orders;
}

// Aave（単一ウォレットの簡易 churn。後方互換／aaveActors 未指定時のフォールバック）。
// 状態機械を 1 ステップ進める: supply -> (borrow <-> repay を反復) -> 債務0のとき確率で withdraw。
// 実時間の本路は buildAaveActorsFlow（複数アクターの持続ポジション）を使う。
export function buildAaveFlow(
  rng: Rng,
  aaveFlowMaxWethWei: bigint,
  maxAaveBorrowUsdcUnits: bigint,
  defaultPriorityFeeWei: bigint,
  reserves: { wethSupplied: bigint; usdcBorrowed: bigint },
  fairPrice: number,
  balance?: FlowBalance | null,
  canPrepareWeth = false,
  activityProb = 0.5,
): FlowOrderOut[] {
  // activityProb の確率でのみこのブロックに送信（既定 0.5。1 で毎ブロック churn、<1 で間欠的）。
  if (rng.next() >= activityProb) return [];
  const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;
  let action: LeafAction;
  if (reserves.wethSupplied === 0n) {
    // supply 額は max の 1/4〜3/4 をランダム（基準 1/2）。
    const amount = randomBigInt(
      rng,
      aaveFlowMaxWethWei / 4n,
      (aaveFlowMaxWethWei * 3n) / 4n,
    );
    if (balance && balance.wethWei < amount * (canPrepareWeth ? 2n : 1n)) {
      if (!canPrepareWeth) return [];
      const usdcIn = capUsdc(wethToUsdcUnits(amount, fairPrice), balance);
      if (usdcIn <= 0n) return [];
      return [
        {
          protocol: "uniswap",
          walletProtocol: "aave",
          kind: "informed",
          action: {
            type: "swap",
            tokenIn: "USDC",
            amountIn: usdcIn.toString(),
            slippageBps: FLOW_SLIPPAGE_BPS,
          } as LeafAction,
          priorityFeeWei: fee,
        },
      ];
    }
    action = {
      type: "aaveSupply",
      asset: "WETH",
      amount: amount.toString(),
    } as unknown as LeafAction;
  } else if (reserves.usdcBorrowed > 0n) {
    action = {
      type: "aaveRepay",
      asset: "USDC",
      amount: "max",
    } as unknown as LeafAction;
  } else if (rng.bool()) {
    const amount = randomBigInt(
      rng,
      maxAaveBorrowUsdcUnits / 10n,
      (maxAaveBorrowUsdcUnits * 3n) / 10n,
    );
    action = {
      type: "aaveBorrow",
      asset: "USDC",
      amount: (amount > 0n ? amount : 100_000_000n).toString(),
    } as unknown as LeafAction;
  } else {
    action = {
      type: "aaveWithdraw",
      asset: "WETH",
      amount: "max",
    } as unknown as LeafAction;
  }
  return [{ protocol: "aave", kind: "informed", action, priorityFeeWei: fee }];
}

// 1 アクターの持続ポジション状態（coordinator が各 actor ウォレットから読んで渡す）。
export type AaveActorState = {
  key: string; // flow ウォレット鍵（例 "aave:actor0"）
  wethSupplied: bigint; // 当該 actor が Aave に supply 済みの WETH
  usdcBorrowed: bigint; // 当該 actor の USDC 債務（持続。翌ブロックも残る）
  wethWei: bigint; // ウォレットの WETH 残高（担保補充の原資）
  usdcUnits: bigint; // ウォレットの USDC 残高（borrow で増え、repay の原資）
};

// Aave 借り手プール（実市場寄せ）。N 個の独立アクターが各自の持続ポジションを保ち、毎ブロック
// それぞれ独立に確率判定して borrow/repay/supply/withdraw を 1 つだけ実行する。borrow の後に強制
// repay しないので債務は翌ブロック以降も残る。1 ブロックの複数 borrow は別アクターから自然発生する
// （最大 = アクター数）。各 borrow は HF 余力（担保 × LTV × 安全率）内に収め revert を避ける。
export function buildAaveActorsFlow(
  rng: Rng,
  actors: AaveActorState[],
  aaveFlowMaxWethWei: bigint,
  maxAaveBorrowUsdcUnits: bigint,
  defaultPriorityFeeWei: bigint,
  fairPrice: number,
  activityProb: number,
): FlowOrderOut[] {
  // 目標レバレッジ方式（staleness 由来の revert を抑える）。flow bot は 1〜2 ブロック遅れの actor 状態で
  // 判断する（非同期パイプライン）ため、HF/残高に大きな余裕を持たせて「少し古い状態でも安全」に倒す:
  //   - 担保は目標まで一度だけ積み、以降は supply しない（supply cap の thrash を避ける）。
  //   - 債務は担保価値の 30%（LT 0.84 に大余裕）を目標に、2 ステップ分の余白を残してのみ小口 borrow
  //     （stale な二重借入が来ても HF を割らない）。達したら一部 repay。
  const targetCollateralWei = aaveFlowMaxWethWei; // 目標担保（≈ aaveFlowMaxWethWei）
  const TARGET_LTV_NUM = 30n;
  const TARGET_LTV_DEN = 100n;
  const minStep = maxAaveBorrowUsdcUnits / 25n; // これ未満の差は動かさない（端数ループ回避）
  const orders: FlowOrderOut[] = [];
  for (const actor of actors) {
    // 各 actor が独立に「今ブロック動くか」を判定（間欠的）。
    if (rng.next() >= activityProb) continue;
    const fee = defaultPriorityFeeWei + BigInt(rng.int(1, 40)) * 1_000_000n;
    const pushAave = (action: LeafAction): void => {
      orders.push({
        protocol: "aave",
        walletKey: actor.key,
        kind: "informed",
        action,
        priorityFeeWei: fee,
      });
    };

    // 1) 担保を目標まで一度だけ積む（80% 到達で確立とみなし以降は supply しない）。
    if (actor.wethSupplied < (targetCollateralWei * 8n) / 10n) {
      const want = targetCollateralWei - actor.wethSupplied;
      // 残高ステイルに備え、ウォレット WETH の 70% までに抑える。
      const amount = minBI(want, (actor.wethWei * 7n) / 10n);
      if (amount > 0n)
        pushAave({
          type: "aaveSupply",
          asset: "WETH",
          amount: amount.toString(),
        } as unknown as LeafAction);
      continue;
    }

    // 2) 担保確立後は借入/返済のみ（持続債務。supply はもうしない）。
    const collateralValueUsdc = wethToUsdcUnits(actor.wethSupplied, fairPrice);
    const targetDebt = (collateralValueUsdc * TARGET_LTV_NUM) / TARGET_LTV_DEN;
    const r = rng.next();

    if (actor.usdcBorrowed + 2n * minStep < targetDebt && r < 0.55) {
      // 目標債務へ向け小口で借り増し（2 ステップ分の余白を残す＝stale 二重借入でも HF 安全）。
      const room = targetDebt - actor.usdcBorrowed;
      const want = randomBigInt(
        rng,
        maxAaveBorrowUsdcUnits / 20n,
        maxAaveBorrowUsdcUnits / 10n,
      );
      const amount = minBI(want, room);
      if (amount > 0n)
        pushAave({
          type: "aaveBorrow",
          asset: "USDC",
          amount: amount.toString(),
        } as unknown as LeafAction);
    } else if (actor.usdcBorrowed > minStep && r < 0.9) {
      // 一部返済（max ではなく部分額 → 債務は残る）。返済はウォレット USDC 残高と債務の小さい方まで。
      const want = randomBigInt(
        rng,
        actor.usdcBorrowed / 4n,
        actor.usdcBorrowed / 2n,
      );
      const amount = minBI(want, actor.usdcUnits);
      if (amount > 0n)
        pushAave({
          type: "aaveRepay",
          asset: "USDC",
          amount: amount.toString(),
        } as unknown as LeafAction);
    }
    // それ以外は no-op（担保確立済・債務目標付近では何もしないブロックもある＝自然）。
  }
  return orders;
}

// wire の文字列 limits を bigint へ復元。
export function decodeFlowLimits(wire: FlowContextWire["limits"]): FlowLimits {
  return {
    uninformedFlowMaxWethWei: BigInt(wire.uninformedFlowMaxWethWei),
    uninformedFlowCountPerBlock: Math.max(
      1,
      Number(wire.uninformedFlowCountPerBlock ?? "1"),
    ),
    uninformedFlowPersistBlocks: Math.max(
      1,
      Number(wire.uninformedFlowPersistBlocks ?? "1"),
    ),
    informedFlowMaxWethWei: BigInt(wire.informedFlowMaxWethWei),
    balancerFlowMaxWethWei: BigInt(wire.balancerFlowMaxWethWei),
    curveFlowMaxWethWei: BigInt(wire.curveFlowMaxWethWei),
    gmxFlowMaxSizeUsd: BigInt(wire.gmxFlowMaxSizeUsd),
    gmxFlowActivityProb: clampProb(wire.gmxFlowActivityProb, 0.5),
    gmxFlowMaxBurst: Math.max(1, Number(wire.gmxFlowMaxBurst ?? "1")),
    aaveFlowMaxWethWei: BigInt(wire.aaveFlowMaxWethWei),
    maxAaveBorrowUsdcUnits: BigInt(wire.maxAaveBorrowUsdcUnits),
    aaveFlowActivityProb: clampProb(wire.aaveFlowActivityProb, 0.5),
    informedArbFeeBps: Math.max(0, Number(wire.informedArbFeeBps ?? "0")),
    uninformedArrivalRate: Math.max(
      0,
      Number(wire.uninformedArrivalRate ?? "0"),
    ),
    uninformedSizeSigma: Math.max(0, Number(wire.uninformedSizeSigma ?? "1")),
    defaultPriorityFeeWei: BigInt(wire.defaultPriorityFeeWei),
  };
}

// FlowContext から 1 ラウンド分の全注文を生成する。
// protocols は coordinator が渡す順（既定 uniswap, balancer, curve, gmx, aave）で反復し、その順で RNG を消費する。
export function buildFlowOrders(
  rng: Rng,
  ctx: FlowContextWire,
): FlowOrderOut[] {
  const limits = decodeFlowLimits(ctx.limits);
  const out: FlowOrderOut[] = [];
  const tag = (protocol: ProtocolId, orders: FlowOrder[]): void => {
    for (const o of orders) out.push({ protocol, ...o });
  };

  // AMM (uniswap/balancer/curve) ごとの [uninformedMax, informedMax]。
  // balancer/curve は単一上限を両方に使う。
  const ammMax: Record<"uniswap" | "balancer" | "curve", [bigint, bigint]> = {
    uniswap: [limits.uninformedFlowMaxWethWei, limits.informedFlowMaxWethWei],
    balancer: [limits.balancerFlowMaxWethWei, limits.balancerFlowMaxWethWei],
    curve: [limits.curveFlowMaxWethWei, limits.curveFlowMaxWethWei],
  };

  for (const protocol of ctx.protocols) {
    if (
      protocol === "uniswap" ||
      protocol === "balancer" ||
      protocol === "curve"
    ) {
      const [uninformedMax, informedMax] = ammMax[protocol];
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          ctx.poolPrices[protocol] ?? ctx.fairPriceUsdcPerWeth,
          ctx.fairPriceUsdcPerWeth,
          uninformedMax,
          informedMax,
          limits.defaultPriorityFeeWei,
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
          "WETH",
          limits.uninformedFlowCountPerBlock,
          ctx.round,
          limits.uninformedFlowPersistBlocks,
          limits.informedArbFeeBps,
          limits.uninformedArrivalRate,
          limits.uninformedSizeSigma,
        ),
      );
    } else if (protocol === "aave") {
      if (ctx.aaveActors && ctx.aaveActors.length > 0) {
        // 実時間の本路: 複数アクターの持続ポジション借り手プール。
        out.push(
          ...buildAaveActorsFlow(
            rng,
            ctx.aaveActors.map((a) => ({
              key: a.key,
              wethSupplied: BigInt(a.wethSupplied),
              usdcBorrowed: BigInt(a.usdcBorrowed),
              wethWei: BigInt(a.wethWei),
              usdcUnits: BigInt(a.usdcUnits),
            })),
            limits.aaveFlowMaxWethWei,
            limits.maxAaveBorrowUsdcUnits,
            limits.defaultPriorityFeeWei,
            ctx.fairPriceUsdcPerWeth,
            limits.aaveFlowActivityProb,
          ),
        );
      } else {
        // 後方互換: 単一ウォレットの簡易 churn。
        out.push(
          ...buildAaveFlow(
            rng,
            limits.aaveFlowMaxWethWei,
            limits.maxAaveBorrowUsdcUnits,
            limits.defaultPriorityFeeWei,
            {
              wethSupplied: BigInt(ctx.aaveReserves?.wethSupplied ?? "0"),
              usdcBorrowed: BigInt(ctx.aaveReserves?.usdcBorrowed ?? "0"),
            },
            ctx.fairPriceUsdcPerWeth,
            flowBalance(ctx, "aave", "informed"),
            ctx.protocols.includes("uniswap"),
            limits.aaveFlowActivityProb,
          ),
        );
      }
    } else if (protocol === "gmx") {
      out.push(
        ...buildGmxFlow(
          rng,
          limits.gmxFlowMaxSizeUsd,
          limits.defaultPriorityFeeWei,
          ctx.fairPriceUsdcPerWeth,
          flowBalance(ctx, "gmx", "uninformed"),
          ctx.protocols.includes("uniswap"),
          limits.gmxFlowActivityProb,
          limits.gmxFlowMaxBurst,
        ),
      );
    }
  }

  // ADR 0013 Phase 8: WETH 以外の base（WBTC 等）の AMM flow。WETH を上で先に処理し終えた後に
  // 後置する。ctx.extraBases が未設定（WETH-only run）なら反復ゼロ = RNG 非消費 = byte 互換。
  // 各 base × venue で max=0/未設定なら early-continue し、その base/venue の RNG を消費しない
  // （WBTC 既定 off で WETH-only の RNG 消費列・出力が一切変わらない）。
  for (const extra of ctx.extraBases ?? []) {
    const extraMax: Record<"uniswap" | "balancer" | "curve", bigint> = {
      uniswap: BigInt(extra.uninformedFlowMaxBaseWei ?? "0"),
      balancer: BigInt(extra.balancerFlowMaxBaseWei ?? "0"),
      curve: BigInt(extra.curveFlowMaxBaseWei ?? "0"),
    };
    const informedMax = BigInt(extra.informedFlowMaxBaseWei ?? "0");
    for (const protocol of ctx.protocols) {
      if (
        protocol !== "uniswap" &&
        protocol !== "balancer" &&
        protocol !== "curve"
      )
        continue;
      const uninformedMax = extraMax[protocol];
      // off（uninformed と informed の両上限が 0）なら RNG を一切消費せず skip。
      const venueInformedMax =
        protocol === "uniswap" ? informedMax : extraMax[protocol];
      if (uninformedMax <= 0n && venueInformedMax <= 0n) continue;
      const poolPrice = extra.poolPrices[protocol];
      if (poolPrice === undefined || poolPrice <= 0) continue;
      tag(
        protocol,
        buildAmmFlow(
          rng,
          protocol,
          poolPrice,
          extra.fairPriceUsd,
          uninformedMax,
          venueInformedMax,
          limits.defaultPriorityFeeWei,
          {
            uninformed: flowBalance(ctx, protocol, "uninformed"),
            informed: flowBalance(ctx, protocol, "informed"),
          },
          ctx.usdcOnlyFlow === true,
          extra.base,
          limits.uninformedFlowCountPerBlock,
          ctx.round,
          limits.uninformedFlowPersistBlocks,
          limits.informedArbFeeBps,
          limits.uninformedArrivalRate,
          limits.uninformedSizeSigma,
        ),
      );
    }
  }

  return out;
}
