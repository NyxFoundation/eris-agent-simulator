// The live competition's schedule, derived from the lottery seed (rules §3.3, §7.1, §7.2; ADR 0023).
//
// Two things are committed to before they are used and revealed after the results:
//
//   the hidden set     regime -> seeds, generated from the same family as the public set. Its hash
//                      is published before the submission period opens (§7.1).
//   the lottery seed   one secret string. Its hash is published when the submission period closes.
//
// From the two, `deriveSchedule` fixes which hidden scenario each of the k epochs replays and in what
// order: every regime appears k / R times, and the lottery seed decides only the order (and, when a
// regime has more hidden seeds than it needs, which of them are used). Nobody chooses which regime
// lands late, where the weight w_s is largest (§3.3's rationale).
//
// The derivation is deliberately plain so a third party can reproduce it from the two revealed
// files and this source: SHA-256 as a counter-mode stream, unbiased integers by rejection, and a
// Fisher-Yates shuffle. No dependency on a PRNG whose implementation might drift between versions.

import { createHash } from "node:crypto";

export type HiddenSet = {
  // regime name -> hidden seeds, at least k / R per regime. Disjoint from the public set.
  regimes: Record<string, number[]>;
  // Optional random salt, so the commitment cannot be brute-forced from a small seed space.
  salt?: string;
};

export type LotterySeed = {
  lotterySeed: string;
  salt?: string;
};

export type EpochPlan = {
  s: number;
  regime: string;
  seed: number;
  /**
   * When the operator intends to start this epoch (ISO 8601). Not part of the commitment: the
   * lottery fixes the order, the timetable is logistics (rules §4.7.1 lets the live week run as
   * several sessions). The dashboard shows the next start from it; nothing scores on it.
   */
  startsAt?: string;
};

/** A timetable for the plan: the first epoch's start and the spacing between starts. */
export type Timetable = { startsAt: string; everyMinutes: number };

export type CompetitionPlan = {
  schema: 1;
  k: number;
  hiddenSetCommitment: string;
  lotterySeedCommitment: string;
  epochs: EpochPlan[];
};

// Canonical JSON: object keys sorted at every level, no whitespace. The commitment must not depend
// on how the file happened to be formatted when it was written.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function commitmentOf(doc: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(doc)).digest("hex")}`;
}

// SHA-256 in counter mode over the lottery seed: block i = sha256(seed || ":" || i), consumed four
// bytes at a time as big-endian uint32.
class HashStream {
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;
  constructor(private readonly seed: string) {}
  nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHash("sha256")
        .update(`${this.seed}:${this.counter++}`)
        .digest();
      this.offset = 0;
    }
    const v = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  // Uniform in [0, n) by rejection: values in the top partial range would bias small n otherwise.
  uniformInt(n: number): number {
    if (n <= 0 || !Number.isInteger(n)) throw new Error(`uniformInt(${n})`);
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % n;
    }
  }
  shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.uniformInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

export function deriveSchedule(
  hidden: HiddenSet,
  lotterySeed: string,
  k: number,
): EpochPlan[] {
  const regimes = Object.keys(hidden.regimes).sort();
  if (regimes.length === 0) throw new Error("the hidden set names no regimes");
  if (!Number.isInteger(k) || k < 1)
    throw new Error(`k must be a positive integer (got ${k})`);
  if (k % regimes.length !== 0)
    throw new Error(
      `k = ${k} is not a multiple of the ${regimes.length} regimes: rules §3.3 require every regime ` +
        "to appear the same number of times",
    );
  if (typeof lotterySeed !== "string" || lotterySeed.length === 0)
    throw new Error("the lottery seed is empty");
  const per = k / regimes.length;
  const stream = new HashStream(lotterySeed);
  // One draw per regime, in name order, then one draw for the epoch order. Fixed sequence, so the
  // result is a function of (hidden set, lottery seed, k) and nothing else.
  const pool: Array<{ regime: string; seed: number }> = [];
  for (const regime of regimes) {
    const seeds = hidden.regimes[regime];
    if (!Array.isArray(seeds) || seeds.some((s) => !Number.isInteger(s)))
      throw new Error(`hidden seeds for ${regime} must be integers`);
    if (new Set(seeds).size !== seeds.length)
      throw new Error(`hidden seeds for ${regime} repeat`);
    if (seeds.length < per)
      throw new Error(
        `regime ${regime} has ${seeds.length} hidden seed(s) but needs ${per} for k = ${k}`,
      );
    const chosen = stream.shuffle(seeds).slice(0, per);
    for (const seed of chosen) pool.push({ regime, seed });
  }
  return stream.shuffle(pool).map((e, i) => ({ s: i + 1, ...e }));
}

export function buildPlan(
  hidden: HiddenSet,
  lottery: LotterySeed,
  k: number,
  timetable?: Timetable,
): CompetitionPlan {
  const epochs = deriveSchedule(hidden, lottery.lotterySeed, k);
  return {
    schema: 1,
    k,
    hiddenSetCommitment: commitmentOf(hidden),
    lotterySeedCommitment: commitmentOf(lottery),
    epochs: timetable ? withTimetable(epochs, timetable) : epochs,
  };
}

/** Stamp each epoch with its intended start: the first at `startsAt`, then every `everyMinutes`. */
export function withTimetable(
  epochs: EpochPlan[],
  timetable: Timetable,
): EpochPlan[] {
  const start = Date.parse(timetable.startsAt);
  if (Number.isNaN(start))
    throw new Error(`timetable.startsAt is not a date: ${timetable.startsAt}`);
  if (!Number.isFinite(timetable.everyMinutes) || timetable.everyMinutes <= 0)
    throw new Error(
      `timetable.everyMinutes must be positive: ${timetable.everyMinutes}`,
    );
  return epochs.map((e) => ({
    ...e,
    startsAt: new Date(
      start + (e.s - 1) * timetable.everyMinutes * 60_000,
    ).toISOString(),
  }));
}
