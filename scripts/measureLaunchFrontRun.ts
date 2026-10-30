// measureLaunchFrontRun: what the `launch` regime's demand wave pays a front-runner, against what it
// pays the two reference agents, without a chain.
//
//   npx tsx scripts/measureLaunchFrontRun.ts [--seeds 2000] [--budget 60000]
//                                            [--fixed-ramp 20,26 | --stop-prob 0.04 --ramp-cap 75]
//
// The schedule is the regime's own (config/regimes/launch.yaml through EventSchedule: the tokens,
// their pools, waves, duds, lengths, holds and sell-backs as the coordinator would run them). Each
// launch pool is a full-range Uniswap V3 position = a constant-product pool with the 0.3% fee on the
// way in, and the wave does what tokenLaunch.ts does: per block it buys toward its cumulative target
// until it stops -- at its drawn length, or for good the first block it finds the pool above
// WAVE_PRICE_CAP_MULT -- then holds, then sells back toward its target.
//
// Timing, measured on a launch run (runs/2026-10-09T14-10-43-459Z): the wave's k-th buy lands in
// ramp block k, and an agent that has seen block t-1 lands in block t -- in front of the wave's buy of
// that block if it outbids the environment (the front-runners below), behind it at the default fee
// (the reference agents). One strategy at a time; tokens still held at the bell are worth 0.
//
//   front-run   confirm on the first wave buy, buy at the best size for what it has seen (the
//               per-block size, the pool, and the length distribution the config publishes) up to
//               its budget split over the confirmed waves, sell the block after the tape shows the
//               wave stopped. "length known" is the same with each wave's length known in advance.
//   one-ahead   while the wave bought last block, buy k times its per-block size in front of this
//               block's buy; sell once a block passes without one. The best k is reported.
//   sniper /    example/agents/launch-sniper and launch-confirm with their default settings.
//   confirm
//
// --fixed-ramp a,b replays the regime as it was before the ramp was memoryless (2026-10-30): every
// token of a window buys over the window's ramp drawn from [a, b] (it was [20, 26]). --stop-prob /
// --ramp-cap try another memoryless ramp in place of the regime's.
process.env.ERIS_LOCAL_DEPLOY = "1";

const { loadRunConfig } = await import("../core/src/runConfig.js");
const { EventSchedule, TOKEN_LAUNCH_LEAD_BLOCKS } = await import(
  "../core/src/realtime/events.js"
);
const { WAVE_PRICE_CAP_MULT } = await import("../core/src/realtime/tokenLaunch.js");
const { setScenarioRegime, resetScenarioRegime } = await import("@eris/sdk/rng.js");
type StressEventConfig = import("../core/src/realtime/events.js").StressEventConfig;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const SEEDS = Number(arg("seeds") ?? 2000);
const BUDGET = Number(arg("budget") ?? 60_000);
const FIXED_RAMP = arg("fixed-ramp")?.split(",").map(Number) as [number, number] | undefined;
const STOP_PROB = arg("stop-prob") === undefined ? undefined : Number(arg("stop-prob"));
const RAMP_CAP = arg("ramp-cap") === undefined ? undefined : Number(arg("ramp-cap"));
const FEE = 0.003;
const SIZE_STEP = 1_000;
const ONE_AHEAD_K = [2, 4, 8, 16, 32];

class Pool {
  constructor(
    public x: number, // USDC
    public y: number, // tokens
  ) {}
  price(): number {
    return this.x / this.y;
  }
  buy(usdc: number): number {
    if (!(usdc > 0)) return 0;
    const ny = (this.x * this.y) / (this.x + usdc * (1 - FEE));
    const out = this.y - ny;
    this.x += usdc;
    this.y = ny;
    return out;
  }
  sell(tokens: number): number {
    if (!(tokens > 0)) return 0;
    const nx = (this.x * this.y) / (this.y + tokens * (1 - FEE));
    const out = this.x - nx;
    this.y += tokens;
    this.x = nx;
    return out;
  }
  quoteSell(tokens: number): number {
    return new Pool(this.x, this.y).sell(tokens);
  }
}

type Wave = {
  pool: Pool;
  S: number; // USDC seeded
  b: number; // USDC per ramp block
  L: number; // ramp blocks
  H: number;
  D: number;
  sellBack: number;
  dud: boolean;
  bought: number;
  // The ramp block at which the price cap stopped the wave (it bought the blocks before it).
  cappedAt?: number;
  tokens: number;
  sold: number;
  heldAtDecay?: number;
  flow: Map<number, number>; // block -> net USDC into the pool, every trader
  stopProb?: number;
  cap: number; // the most blocks a wave of this event can buy
  rampRange?: [number, number]; // the fixed-ramp regime's window ramp range
};

function note(w: Wave, t: number, usdc: number): void {
  w.flow.set(t, (w.flow.get(t) ?? 0) + usdc);
}

// The blocks the wave buys for: its drawn length, or fewer when the price cap stopped it.
const rampOf = (w: Wave) => w.cappedAt ?? w.L;

/** One block of tokenLaunch.ts's driver: buy toward the cumulative target, else sell back. */
function waveStep(w: Wave, t: number): void {
  if (w.dud || t < 0) return;
  const delta = w.b * Math.min(t + 1, rampOf(w)) - w.bought;
  if (delta > 1e-9) {
    if (w.pool.price() <= WAVE_PRICE_CAP_MULT) {
      w.tokens += w.pool.buy(delta);
      w.bought += delta;
      note(w, t, delta);
    } else w.cappedAt = Math.min(w.L, t); // the cap ends the wave, as a drawn stop would
    return;
  }
  const decay0 = rampOf(w) + w.H;
  if (t < decay0) return;
  if (w.heldAtDecay === undefined) w.heldAtDecay = w.tokens;
  const target = w.heldAtDecay * w.sellBack * Math.min(1, (t - decay0 + 1) / w.D);
  const s = Math.min(target - w.sold, w.tokens);
  if (s > 1e-12) {
    const got = w.pool.sell(s);
    w.tokens -= s;
    w.sold += s;
    note(w, t, -got);
  }
}

const buyingAt = (w: Wave, t: number) => !w.dud && t >= 0 && t < rampOf(w);

abstract class Agent {
  usdc: number;
  tokens = new Map<number, number>();
  constructor(
    readonly usdc0: number,
    readonly highFee: boolean,
  ) {
    this.usdc = usdc0;
  }
  abstract act(t: number, waves: Wave[]): void;
  buy(w: Wave, i: number, t: number, usdc: number): void {
    const amount = Math.min(usdc, this.usdc);
    if (!(amount > 0)) return;
    this.usdc -= amount;
    this.tokens.set(i, (this.tokens.get(i) ?? 0) + w.pool.buy(amount));
    note(w, t, amount);
  }
  sell(w: Wave, i: number, t: number): void {
    const held = this.tokens.get(i) ?? 0;
    if (!(held > 0)) return;
    const got = w.pool.sell(held);
    this.tokens.set(i, 0);
    this.usdc += got;
    note(w, t, -got);
  }
  pnl(): number {
    return this.usdc - this.usdc0; // tokens at the bell are worth nothing (ADR 0022 axiom 2)
  }
}

/** example/agents/launch-sniper, default settings: 20% of USDC at first sight, sell 30 blocks on. */
class Sniper extends Agent {
  private entered = new Map<number, { at: number; done: boolean }>();
  constructor() {
    super(25_000, false);
  }
  act(t: number, waves: Wave[]): void {
    if (t < 0) return;
    for (const [i, p] of this.entered) {
      if (p.done || !((this.tokens.get(i) ?? 0) > 0) || t - p.at < 30) continue;
      this.sell(waves[i], i, t);
      p.done = true;
      return;
    }
    for (let i = 0; i < waves.length; i++) {
      if (this.entered.has(i)) continue;
      this.entered.set(i, { at: t, done: false });
      this.buy(waves[i], i, t, this.usdc * 0.2);
      return;
    }
  }
}

/** example/agents/launch-confirm, default settings. */
class Confirm extends Agent {
  private watch = new Map<
    number,
    { read: number; streak: number; entered?: number; done: boolean }
  >();
  constructor() {
    super(25_000, false);
  }
  act(t: number, waves: Wave[]): void {
    if (t < 0) return;
    let acted = false;
    waves.forEach((w, i) => {
      if (!this.watch.has(i)) this.watch.set(i, { read: t - 1, streak: 0, done: false });
      const s = this.watch.get(i)!;
      if (s.done) return;
      const reserve = w.pool.x;
      let net = 0;
      for (let b = s.read + 1; b < t; b++) net += w.flow.get(b) ?? 0;
      s.read = t - 1;
      const netBps = Math.trunc((net * 10_000) / reserve);
      if (net > 0 && netBps >= 25) s.streak++;
      else if (net < 0) s.streak = 0;
      if (acted) return;
      if (s.entered !== undefined) {
        if (!((this.tokens.get(i) ?? 0) > 0)) return;
        if ((net < 0 && -netBps >= 10) || t - s.entered >= 60) {
          this.sell(w, i, t);
          s.done = true;
          acted = true;
        }
        return;
      }
      if (s.streak < 3) return;
      const amount = Math.min(this.usdc * 0.2, reserve * 0.1);
      if (amount < 1) return;
      s.entered = t;
      this.buy(w, i, t, amount);
      acted = true;
    });
  }
}

/** P(L = n | the first buy was seen), n = 1..cap, from what the config publishes. */
function lengthWeights(w: Wave): number[] {
  if (w.stopProb !== undefined) {
    const q = 1 - w.stopProb;
    const out = Array.from({ length: w.cap }, (_, k) => q ** k * w.stopProb!);
    out[w.cap - 1] = q ** (w.cap - 1);
    return out;
  }
  const [lo, hi] = w.rampRange!;
  return Array.from({ length: hi }, (_, k) => (k + 1 >= lo ? 1 / (hi - lo + 1) : 0));
}

/** Profit of buying `size` after the wave's first buy, for every length 1..weights.length. */
function frontRunProfits(S: number, b: number, size: number, maxLen: number): number[] {
  const p = new Pool(S, S);
  p.buy(b);
  let bought = b;
  const tokens = p.buy(size);
  const out = [p.quoteSell(tokens) - size];
  let capped = false;
  for (let k = 1; k < maxLen; k++) {
    // The first block above the cap ends the wave (tokenLaunch.ts).
    if (!capped && p.price() > WAVE_PRICE_CAP_MULT) capped = true;
    if (!capped) {
      p.buy(b * (k + 1) - bought);
      bought = b * (k + 1);
    }
    out.push(p.quoteSell(tokens) - size);
  }
  return out;
}

function bestSize(S: number, b: number, cap: number, weights: number[]): number {
  let best = 0;
  let bestValue = 0;
  for (let size = SIZE_STEP; size <= cap + 1e-9; size += SIZE_STEP) {
    const profits = frontRunProfits(S, b, size, weights.length);
    const value = weights.reduce((a, wt, k) => a + wt * profits[k], 0);
    if (value > bestValue) [best, bestValue] = [size, value];
  }
  return best;
}

class FrontRun extends Agent {
  private open = new Set<number>();
  constructor(private hindsight: boolean) {
    super(BUDGET, true);
  }
  act(t: number, waves: Wave[]): void {
    if (t === 1) {
      const live = waves.flatMap((w, i) => (buyingAt(w, 0) ? [i] : []));
      for (const i of live) {
        const w = waves[i];
        const weights = this.hindsight
          ? Array.from({ length: w.L }, (_, k) => (k === w.L - 1 ? 1 : 0))
          : lengthWeights(w);
        const size = bestSize(w.S, w.b, BUDGET / live.length, weights);
        if (size > 0) {
          this.buy(w, i, t, size);
          this.open.add(i);
        }
      }
      return;
    }
    for (const i of this.open)
      if (!buyingAt(waves[i], t - 1)) {
        this.sell(waves[i], i, t);
        this.open.delete(i);
      }
  }
}

class OneAhead extends Agent {
  private spent = new Map<number, number>();
  constructor(private k: number) {
    super(BUDGET, true);
  }
  act(t: number, waves: Wave[]): void {
    if (t < 1) return;
    const live = waves.flatMap((w, i) => (buyingAt(w, 0) ? [i] : []));
    for (const i of live) {
      const w = waves[i];
      if (buyingAt(w, t - 1)) {
        const room = BUDGET / live.length - (this.spent.get(i) ?? 0);
        const amount = Math.min(this.k * w.b, room);
        if (amount > 1) {
          this.spent.set(i, (this.spent.get(i) ?? 0) + amount);
          this.buy(w, i, t, amount);
        }
      } else if ((this.tokens.get(i) ?? 0) > 0) this.sell(w, i, t);
    }
  }
}

// ---- the regime's own schedule ----
setScenarioRegime("launch");
const { config } = loadRunConfig("config/regimes/launch.yaml", { SEED: 1 });
const events: StressEventConfig[] = config.stressEvents.map((c) =>
  c.type !== "tokenLaunch"
    ? c
    : FIXED_RAMP
      ? { ...c, waveStopProb: undefined, rampBlocks: FIXED_RAMP }
      : {
          ...c,
          ...(STOP_PROB !== undefined ? { waveStopProb: STOP_PROB } : {}),
          ...(RAMP_CAP !== undefined ? { rampBlocks: RAMP_CAP } : {}),
        },
);
const launchEvent = events.find((e) => e.type === "tokenLaunch");
if (!launchEvent) throw new Error("config/regimes/launch.yaml has no tokenLaunch event");
const launch: StressEventConfig = launchEvent;

/** Every token of every launch window of one seed, as fresh pools. */
function epochWaves(seed: number): Wave[][] {
  const schedule = new EventSchedule(events, seed, config.runBlocks);
  const out: Wave[][] = [];
  for (const ev of schedule.events) {
    if (ev.type !== "tokenLaunch") continue;
    out.push(
      (ev.launches ?? []).map((l) => {
        const L = l.rampBlocks ?? ev.rampBlocks;
        const total = l.liquidityUsdc * l.waveUsdcMult;
        return {
          pool: new Pool(l.liquidityUsdc, l.liquidityUsdc),
          S: l.liquidityUsdc,
          b: L > 0 ? total / L : 0,
          L,
          H: ev.holdBlocks,
          D: ev.decayBlocks,
          sellBack: l.sellBackFrac,
          dud: l.dud,
          bought: 0,
          tokens: 0,
          sold: 0,
          flow: new Map(),
          ...(launch.waveStopProb !== undefined ? { stopProb: launch.waveStopProb } : {}),
          cap: Array.isArray(launch.rampBlocks) ? launch.rampBlocks[1] : launch.rampBlocks,
          ...(Array.isArray(launch.rampBlocks) ? { rampRange: launch.rampBlocks } : {}),
        };
      }),
    );
  }
  return out;
}

function runWindow(waves: Wave[], agent: Agent | null): number {
  const end = Math.max(...waves.map((w) => w.L + w.H + w.D)) + 70;
  for (let t = -1; t < end; t++) {
    if (agent?.highFee) agent.act(t, waves);
    for (const w of waves) waveStep(w, t);
    if (agent && !agent.highFee) agent.act(t, waves);
  }
  return waves.reduce((a, w) => a + w.bought, 0);
}

function measure(make: () => Agent): { mean: number; se: number; p10: number; p90: number } {
  const xs: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    let pnl = 0;
    for (const waves of epochWaves(seed)) {
      const agent = make();
      runWindow(waves, agent);
      pnl += agent.pnl();
    }
    xs.push(pnl);
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  xs.sort((a, b) => a - b);
  return {
    mean,
    se: sd / Math.sqrt(xs.length),
    p10: xs[Math.floor(xs.length / 10)],
    p90: xs[Math.floor((9 * xs.length) / 10)],
  };
}

console.log(
  `launch, ${SEEDS} seeds, budget ${BUDGET.toLocaleString("en-US")} USDC: ` +
    (launch.waveStopProb !== undefined
      ? `memoryless ramp (waveStopProb ${launch.waveStopProb}, at most ${JSON.stringify(launch.rampBlocks)} blocks)`
      : `fixed ramp ${JSON.stringify(launch.rampBlocks)}`) +
    `, lead ${TOKEN_LAUNCH_LEAD_BLOCKS}, wave price cap ${WAVE_PRICE_CAP_MULT}x`,
);
let gross = 0;
let waves = 0;
let capped = 0;
for (let seed = 1; seed <= SEEDS; seed++)
  for (const window of epochWaves(seed)) {
    gross += runWindow(window, null);
    for (const w of window)
      if (!w.dud) {
        waves++;
        if (w.bought < w.b * w.L - 1e-6) capped++;
      }
  }
const row = (label: string, r: ReturnType<typeof measure>) =>
  console.log(
    `  ${label.padEnd(28)} ${r.mean.toFixed(0).padStart(8)} ±${r.se.toFixed(0).padStart(4)}   p10 ${r.p10.toFixed(0).padStart(7)}   p90 ${r.p90.toFixed(0).padStart(7)}`,
  );
console.log(
  `  wave gross per epoch, nobody else trading: ${(gross / SEEDS).toFixed(0)} USDC; ` +
    `${((100 * capped) / Math.max(1, waves)).toFixed(1)}% of waves stopped by the price cap on their own`,
);
console.log("  P per epoch (USDC)            mean    ±se");
row("front-run, best size", measure(() => new FrontRun(false)));
row("front-run, length known", measure(() => new FrontRun(true)));
let best: { k: number; r: ReturnType<typeof measure> } | null = null;
for (const k of ONE_AHEAD_K) {
  const r = measure(() => new OneAhead(k));
  if (!best || r.mean > best.r.mean) best = { k, r };
}
row(`one block ahead, k = ${best!.k}`, best!.r);
row("launch-sniper", measure(() => new Sniper()));
row("launch-confirm", measure(() => new Confirm()));
resetScenarioRegime();
