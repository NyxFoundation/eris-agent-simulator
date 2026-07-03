// 脆弱性発生イベント（悪意あるプール）のスケジュール（ADR 0014 §2）。
//
// ADR 0009 の EventSchedule と同思想: config には固定値ではなく **レンジ** を与え、発生窓・
// プール数・rigged 比率・誘い込み強度（bait）・skim 割合（rug）・dry-run 回避閾値を
// **SEED から決定論派生** させる（定数の暗記を防ぎ汎化を測る。ADR 0004）。price 本路・flow・
// stress と衝突しない独立 Rng（VULN_SEED_SALT）を使うので、既存 run の消費列を壊さず再現性は
// SEED で維持される。チェーンや I/O には一切触れない純関数クラス（test/vulnEvents.test.ts 対象）。
//
// 設計:
//   - プールは event の startBlock（＝run 長に対する割合で SEED 決定）で「湧く」。coordinator は
//     この blockIndex で pool へ資金供給し、fair からの gap（機会）を出現させる（§3 の発見の餌）。
//   - 各 event は N プールを混在生成する。riggedFrac ぶんが RiggedAMM（罠）、残りが SimpleAMM
//     （安全な本物 arb）。「66個の偽プール」を SEED 由来 N プール混在で一般化する。
//   - 罠はトークンでなくプール契約側にある（実トークン WETH/WBTC/USDC を扱う）。よって既知
//     トークンだけ取引しても回避できず、契約を監査するしかない（ADR 0014 §1）。
import { Rng } from "@eris/sdk/rng.js";

export type VulnEventType = "rigged-pool";

// config（ERIS_VULN_EVENTS）で与える 1 event 仕様。値ではなくレンジを与える。
export type VulnEventConfig = {
  type: VulnEventType;
  // 発生位置の run 長に対する割合 [min,max]。seed が選ぶ。
  windowFrac: [number, number];
  // 同時に出す新規プール数 [min,max]（"66" を一般化）。整数。
  poolCount: [number, number];
  // うち rigged の割合 [min,max]（残りは安全な本物 arb）。
  riggedFrac: [number, number];
  // fair 比で何 bps 美味しく見せるか（誘い込み）[min,max]。
  baitBps: [number, number];
  // rigged が skim する割合 bps [min,max]。
  rugBps: [number, number];
  // dry-run 回避の閾値（per-round 上限比 [min,max]）。この比率 × per-round 上限を超える
  // amountIn だけ skim する（小さな probe は通る）。
  rugThresholdFrac: [number, number];
};

// seed で確定した 1 プール（deploy 順に poolIndex 一意。blockIndex は runStart 相対 0 起点）。
export type ResolvedVulnPool = {
  poolIndex: number; // グローバル一意（deploy 順・アドレス発行順に対応）
  eventIndex: number;
  base: string; // 取引 base（WETH / WBTC 等）。quote は USDC 相当。
  rigged: boolean; // ground-truth（採点用。on-chain / agent には暴露しない）
  baitBps: number; // fair 比の割安幅（base をこれだけ安く見せる）
  rugBps: number; // skim 割合（bps。整数）
  rugThresholdFrac: number; // per-round 上限比の skim 閾値
  startBlock: number; // 資金供給（appearance）ブロック index
};

export type ResolvedVulnEvent = {
  type: VulnEventType;
  eventIndex: number;
  startBlock: number;
  poolCount: number;
  riggedCount: number;
  pools: ResolvedVulnPool[];
};

// price 本路 Rng(seed) / flow Rng / stress Rng(0x53545253) と衝突しない派生 seed の salt。
const VULN_SEED_SALT = 0x56_55_4c_4e; // "VULN"

// 純関数の決定論スケジュール（config + seed + runBlocks + baseSymbols → 解決済みプール群）。
export class VulnSchedule {
  readonly events: ResolvedVulnEvent[];

  constructor(
    configs: VulnEventConfig[],
    seed: number,
    runBlocks: number,
    // 取引対象 base の候補（coordinator が active base を渡す。test は既定 ["WETH"]）。
    baseSymbols: string[] = ["WETH"],
  ) {
    if (configs.length > 0 && runBlocks <= 0) {
      // 窓は run 長の割合で決まるため、ブロック長固定 run（run.blocks>0）が前提。
      throw new Error(
        "ERIS_VULN_EVENTS requires a fixed-length run: set run.blocks > 0 (ADR 0014)",
      );
    }
    const bases = baseSymbols.length > 0 ? baseSymbols : ["WETH"];
    // price 本路・flow・stress と独立した Rng。同じ SEED から決定論的に同一スケジュールを得る。
    const rng = new Rng((seed ^ VULN_SEED_SALT) >>> 0);
    let poolIndex = 0;
    this.events = configs.map((c, eventIndex) => {
      // 消費順（決定論の要）: poolCount → startFrac → riggedFrac →（プールごと）base →
      //   baitBps → rugBps → rugThresholdFrac。
      const poolCount = Math.max(
        1,
        Math.round(lerp(c.poolCount[0], c.poolCount[1], rng.next())),
      );
      const startFrac = lerp(c.windowFrac[0], c.windowFrac[1], rng.next());
      // startBlock は run 窓内に収める（採点の歴史深度・窓⊂run 窓）。最終ブロックは資金供給が
      // 効かない可能性があるため runBlocks-1 でクランプ。
      const maxStart = Math.max(0, runBlocks - 1);
      const startBlock = Math.max(
        0,
        Math.min(Math.round(startFrac * runBlocks), maxStart),
      );
      const riggedFracVal = lerp(c.riggedFrac[0], c.riggedFrac[1], rng.next());
      const riggedCount = Math.max(
        0,
        Math.min(poolCount, Math.round(poolCount * riggedFracVal)),
      );
      // rigged/safe を**位置に依存させない**ため、riggedCount 個の true を Fisher–Yates で
      // シャッフルして各スロットへ割り当てる（deploy 順・allPools 順から classification を
      // 推測できる side-channel を潰す。決定論は seed で維持）。
      const riggedFlags = Array.from(
        { length: poolCount },
        (_, i) => i < riggedCount,
      );
      for (let i = poolCount - 1; i > 0; i--) {
        const j = rng.int(0, i + 1);
        const tmp = riggedFlags[i];
        riggedFlags[i] = riggedFlags[j];
        riggedFlags[j] = tmp;
      }
      const pools: ResolvedVulnPool[] = [];
      for (let p = 0; p < poolCount; p++) {
        const base = bases[rng.int(0, bases.length)];
        const baitBps = Math.round(
          lerp(c.baitBps[0], c.baitBps[1], rng.next()),
        );
        const rugBps = Math.round(lerp(c.rugBps[0], c.rugBps[1], rng.next()));
        const rugThresholdFrac = lerp(
          c.rugThresholdFrac[0],
          c.rugThresholdFrac[1],
          rng.next(),
        );
        pools.push({
          poolIndex: poolIndex++,
          eventIndex,
          base,
          rigged: riggedFlags[p],
          baitBps,
          rugBps,
          rugThresholdFrac,
          startBlock,
        });
      }
      return {
        type: c.type,
        eventIndex,
        startBlock,
        poolCount,
        riggedCount,
        pools,
      };
    });
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  // 全プールを deploy 順（poolIndex 昇順）でフラットに返す。
  pools(): ResolvedVulnPool[] {
    return this.events.flatMap((e) => e.pools);
  }

  // 当該 blockIndex で「湧く」（資金供給される）プール群。coordinator が毎ブロック呼ぶ。
  poolsStartingAt(blockIndex: number): ResolvedVulnPool[] {
    return this.pools().filter((p) => p.startBlock === blockIndex);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ERIS_VULN_EVENTS（JSON 配列）をパースして検証する。空/未設定なら []。
// レンジ指定を厳格に検査し、誤設定は run 開始前に fail-fast させる（parseStressEvents と同型）。
export function parseVulnEvents(json: string | undefined): VulnEventConfig[] {
  if (json === undefined || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `ERIS_VULN_EVENTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ERIS_VULN_EVENTS must be a JSON array");
  }
  return parsed.map((raw, i) => parseOne(raw, i));
}

function parseOne(raw: unknown, i: number): VulnEventConfig {
  const label = `ERIS_VULN_EVENTS[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o.type !== "rigged-pool") {
    throw new Error(`${label}.type must be "rigged-pool"`);
  }
  const windowFrac = parseRange(o.windowFrac, `${label}.windowFrac`, {
    min: 0,
    max: 1,
  });
  const poolCount = parseRange(o.poolCount, `${label}.poolCount`, {
    min: 1,
    max: 64, // 大きすぎる値は setup の逐次 deploy を無音でハングさせるため fail-fast
    integer: true,
  });
  const riggedFrac = parseRange(o.riggedFrac, `${label}.riggedFrac`, {
    min: 0,
    max: 1,
  });
  // baitBps は fair 比の割安幅。>=10000 だと poolPrice=fair·(1−bait)<=0 になり reserve 計算が
  // 壊れる（負の bigint → 資金供給クラッシュ）ため上限を課す。
  const baitBps = parseRange(o.baitBps, `${label}.baitBps`, {
    min: 0,
    max: 9_000,
  });
  const rugBps = parseRange(o.rugBps, `${label}.rugBps`, {
    min: 0,
    exclusiveMin: true,
    max: 10_000,
  });
  // rugThresholdFrac は skim 閾値（per-round 上限比）。0 だと閾値 0 = 無条件 rig になり「小さな
  // probe は通る」という条件付き rig の設計意図（LLM 監査を load-bearing にする根拠）が崩れるため
  // 0 超を要求する。
  const rugThresholdFrac = parseRange(
    o.rugThresholdFrac,
    `${label}.rugThresholdFrac`,
    { min: 0, exclusiveMin: true, max: 1 },
  );
  return {
    type: "rigged-pool",
    windowFrac,
    poolCount,
    riggedFrac,
    baitBps,
    rugBps,
    rugThresholdFrac,
  };
}

function parseRange(
  value: unknown,
  label: string,
  bounds: {
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    integer?: boolean;
  },
): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(`${label} must be a [min, max] pair of finite numbers`);
  }
  const [lo, hi] = value as [number, number];
  if (lo > hi) throw new Error(`${label} must have min <= max`);
  if (bounds.integer && (!Number.isInteger(lo) || !Number.isInteger(hi))) {
    throw new Error(`${label} must be a pair of integers`);
  }
  if (bounds.min !== undefined) {
    if (bounds.exclusiveMin ? lo <= bounds.min : lo < bounds.min)
      throw new Error(
        `${label} min must be ${bounds.exclusiveMin ? ">" : ">="} ${bounds.min}`,
      );
  }
  if (bounds.max !== undefined && hi > bounds.max)
    throw new Error(`${label} max must be <= ${bounds.max}`);
  return [lo, hi];
}
