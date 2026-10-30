import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  EventSchedule,
  TOKEN_LAUNCH_LEAD_BLOCKS,
  launchSellBackFrac,
  parseStressEvents,
  waveLengthFrom,
  waveLengthMean,
  type StressEventConfig,
} from "../core/src/realtime/events.js";
import {
  LAUNCH_WALLET_SLOTS,
  LAUNCH_WALLET_USDC_UNITS,
  LAUNCH_WAVE_USDC_UNITS,
  launchWalletFunding,
  scaleUnits,
  tokenLaunchCeiling,
  tokenLaunchEndowments,
  capStopRamp,
  waveBuyCapped,
  waveCapUsdcPerToken,
  waveBlockUsdcUnits,
  waveBuyTargetUnits,
  waveTargets,
  waveUsdcUnits,
} from "../core/src/realtime/tokenLaunch.js";

// Issue #29: a token-launch window lists 2-3 tokens at once and draws a demand wave per token,
// with a mass at zero (the dud). These pin the draw, the targets the driver reconciles toward,
// and the parser's refusals, without a chain.

const LAUNCH = (over: Partial<StressEventConfig> = {}): StressEventConfig => ({
  type: "tokenLaunch",
  magnitudeRange: [0, 0],
  windowFrac: [0.3, 0.3],
  tokenCount: [2, 3],
  liquidityUsdc: [20_000, 100_000],
  waveUsdcMult: [0.5, 2],
  dudProb: [0.3, 0.5],
  sellBackFrac: [0.5, 1],
  rampBlocks: 9,
  holdBlocks: 30,
  decayBlocks: 30,
  ...over,
});

test("a launch window lists between tokenCount tokens, all on one start block", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new EventSchedule([LAUNCH()], seed, 360);
    const ev = s.events[0];
    assert.ok(ev.launches !== undefined);
    assert.ok(
      ev.launches.length >= 2 && ev.launches.length <= 3,
      `${ev.launches.length}`,
    );
    assert.equal(ev.startBlock, 108); // round(0.3 * 360)
    // lead 2 (listing + registry publication) + ramp 9 + hold 30 + decay 30
    assert.equal(ev.endBlock, 108 + TOKEN_LAUNCH_LEAD_BLOCKS + 69);
    for (const l of ev.launches) {
      assert.ok(l.liquidityUsdc >= 20_000 && l.liquidityUsdc <= 100_000);
      assert.ok(l.sellBackFrac >= 0.5 && l.sellBackFrac <= 1);
      if (l.dud) assert.equal(l.waveUsdcMult, 0);
      else assert.ok(l.waveUsdcMult >= 0.5 && l.waveUsdcMult <= 2);
    }
  }
});

test("the dud is a mass at zero: dudProb 1 makes every launch a dud, dudProb 0 none", () => {
  const all = new EventSchedule([LAUNCH({ dudProb: [1, 1] })], 7, 360).events[0]
    .launches!;
  assert.ok(all.every((l) => l.dud && l.waveUsdcMult === 0));
  const none = new EventSchedule([LAUNCH({ dudProb: [0, 0] })], 7, 360)
    .events[0].launches!;
  assert.ok(none.every((l) => !l.dud && l.waveUsdcMult >= 0.5));
});

test("both outcomes occur across seeds, and waves are drawn per token", () => {
  let duds = 0;
  let waves = 0;
  let mixedWindows = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const launches = new EventSchedule([LAUNCH()], seed, 360).events[0]
      .launches!;
    const d = launches.filter((l) => l.dud).length;
    duds += d;
    waves += launches.length - d;
    if (d > 0 && d < launches.length) mixedWindows++;
    // Independent draws: two non-dud tokens in one window do not share a wave size.
    const sizes = new Set(
      launches.filter((l) => !l.dud).map((l) => l.waveUsdcMult),
    );
    assert.equal(sizes.size, launches.length - d);
  }
  assert.ok(duds > 0 && waves > 0, `duds ${duds} waves ${waves}`);
  assert.ok(
    mixedWindows > 0,
    "no window with both a dud and a wave in 60 seeds",
  );
});

test("the launch draws do not shift the events around them", () => {
  const crash: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.2, 0.8],
    rampBlocks: 3,
    holdBlocks: 6,
    decayBlocks: 8,
  };
  const alone = new EventSchedule([crash], 11, 360).events[0];
  const withLaunchAfter = new EventSchedule([crash, LAUNCH()], 11, 360)
    .events[0];
  assert.deepEqual(withLaunchAfter, alone);
  // The same seed lists the same tokens whether or not a crash follows.
  const a = new EventSchedule([LAUNCH()], 11, 360).events[0].launches;
  const b = new EventSchedule([LAUNCH(), crash], 11, 360).events[0].launches;
  assert.deepEqual(a, b);
});

test("targets: buy rises over the ramp and stays, sell-back rises over the decay and stays", () => {
  const s = new EventSchedule(
    [LAUNCH({ dudProb: [0, 0], tokenCount: [1, 1] })],
    3,
    360,
  );
  const ev = s.events[0];
  const l = ev.launches![0];
  const at = (i: number) => s.tokenLaunchTargetsAt(i)[0];
  assert.equal(s.tokenLaunchTargetsAt(ev.startBlock - 1)[0].listed, false);
  assert.equal(at(ev.startBlock - 1).buyFrac, 0);
  assert.equal(at(ev.startBlock).listed, true);
  // The listing block and the registry's publication block carry no buying: the ramp starts when
  // the pool is visible (TOKEN_LAUNCH_LEAD_BLOCKS = 2), so the tape's first print is one agents
  // could have watched for.
  assert.equal(at(ev.startBlock).buyFrac, 0);
  assert.equal(at(ev.startBlock + 1).buyFrac, 0);
  const ramp0 = ev.startBlock + TOKEN_LAUNCH_LEAD_BLOCKS;
  assert.ok(Math.abs(at(ramp0).buyFrac - 1 / 9) < 1e-12);
  assert.equal(at(ramp0 + 8).buyFrac, 1);
  assert.equal(at(ramp0 + 20).buyFrac, 1);
  assert.equal(at(ramp0 + 20).sellBackFrac, 0);
  const decayStart = ramp0 + 9 + 30;
  assert.ok(
    Math.abs(at(decayStart).sellBackFrac - l.sellBackFrac / 30) < 1e-12,
  );
  assert.ok(
    Math.abs(at(decayStart + 29).sellBackFrac - l.sellBackFrac) < 1e-12,
  );
  // Past the window: nothing is undone.
  assert.equal(at(ev.endBlock + 50).buyFrac, 1);
  assert.ok(
    Math.abs(at(ev.endBlock + 50).sellBackFrac - l.sellBackFrac) < 1e-12,
  );
  assert.equal(at(ev.endBlock).justClosed, true);
  assert.equal(at(ev.endBlock + 1).justClosed, false);
});

test("a dud's targets are zero throughout", () => {
  const s = new EventSchedule(
    [LAUNCH({ dudProb: [1, 1], tokenCount: [1, 1] })],
    3,
    360,
  );
  const ev = s.events[0];
  for (const i of [
    ev.startBlock,
    ev.startBlock + 20,
    ev.endBlock - 1,
    ev.endBlock + 10,
  ]) {
    const t = s.tokenLaunchTargetsAt(i)[0];
    assert.equal(t.buyFrac, 0);
    assert.equal(t.sellBackFrac, 0);
  }
});

// ---- the memoryless wave (waveStopProb) ----

const MEMORYLESS = (over: Partial<StressEventConfig> = {}) =>
  LAUNCH({
    waveUsdcMult: [0.25, 1],
    rampBlocks: 75,
    holdBlocks: [24, 36],
    decayBlocks: [28, 36],
    waveStopProb: 0.04,
    ...over,
  });

test("waveLengthFrom inverts the geometric: P(L > n) = (1 - p)^n, at least 1, cut at the cap", () => {
  const p = 0.04;
  assert.equal(waveLengthFrom(0, p, 75), 1);
  for (const n of [1, 5, 23, 60]) {
    const edge = 1 - (1 - p) ** n; // u below this: L <= n; at or above: L > n
    assert.equal(waveLengthFrom(edge - 1e-9, p, 75), n, `n ${n}`);
    assert.equal(waveLengthFrom(edge + 1e-9, p, 75), n + 1, `n ${n}`);
  }
  assert.equal(waveLengthFrom(0.999999999, p, 75), 75);
  // The closed form of the mean is the sum it stands for.
  let sum = 0;
  for (let n = 1; n <= 75; n++) sum += n * (n < 75 ? (1 - p) ** (n - 1) * p : (1 - p) ** 74);
  assert.ok(Math.abs(waveLengthMean(p, 75) - sum) < 1e-9);
  assert.ok(Math.abs(waveLengthMean(p, 75) - 23.83) < 0.01);
});

test("memoryless lengths: per token, deterministic, inside [1, cap], and geometric", () => {
  const lengths: number[] = [];
  for (let seed = 1; seed <= 1500; seed++) {
    const a = new EventSchedule([MEMORYLESS()], seed, 360).events[0];
    const b = new EventSchedule([MEMORYLESS()], seed, 360).events[0];
    assert.deepEqual(a, b, `seed ${seed}`);
    for (const l of a.launches!) {
      assert.ok(Number.isInteger(l.rampBlocks) && l.rampBlocks! >= 1 && l.rampBlocks! <= 75);
      lengths.push(l.rampBlocks!);
    }
  }
  const n = lengths.length;
  const mean = lengths.reduce((s, x) => s + x, 0) / n;
  const expected = waveLengthMean(0.04, 75);
  // sd of a capped geometric at p = 0.04 is ~19 blocks: 4 standard errors.
  assert.ok(Math.abs(mean - expected) < (4 * 19) / Math.sqrt(n), `mean ${mean} vs ${expected}`);
  // No memory: a wave that has bought 15 blocks is as likely to buy 15 more as a new one is.
  const past = (k: number) => lengths.filter((x) => x > k).length;
  const fresh = past(15) / n;
  const aged = past(30) / past(15);
  assert.ok(Math.abs(fresh - 0.96 ** 15) < 0.03, `P(L > 15) ${fresh}`);
  assert.ok(Math.abs(aged - fresh) < 0.05, `P(L > 30 | L > 15) ${aged} vs ${fresh}`);
  // The cap takes what is left of the tail, and two tokens of one window do not share a length.
  const atCap = lengths.filter((x) => x === 75).length / n;
  assert.ok(Math.abs(atCap - 0.96 ** 74) < 0.02, `P(L = 75) ${atCap}`);
  let differ = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const ls = new EventSchedule([MEMORYLESS()], seed, 360).events[0].launches!;
    if (new Set(ls.map((l) => l.rampBlocks)).size > 1) differ++;
  }
  assert.ok(differ > 40, `${differ} of 50 windows gave every token the same length`);
});

test("the length has a stream of its own: the window's other draws and the events after it do not move", () => {
  // On the seed-only stream the main draws do not depend on what the list says, so the same seed
  // must list the same pools, duds, sell-backs, start and hold with and without the stop.
  const crash: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.2, 0.8],
    rampBlocks: 3,
    holdBlocks: 6,
    decayBlocks: 8,
  };
  const opts = { saltWithEventList: false };
  for (let seed = 1; seed <= 30; seed++) {
    const fixed = new EventSchedule([MEMORYLESS({ waveStopProb: undefined }), crash], seed, 360, 360, opts);
    const memoryless = new EventSchedule([MEMORYLESS(), crash], seed, 360, 360, opts);
    const [f, m] = [fixed.events[0], memoryless.events[0]];
    assert.equal(m.startBlock, f.startBlock);
    assert.equal(m.holdBlocks, f.holdBlocks);
    assert.equal(m.decayBlocks, f.decayBlocks);
    assert.equal(m.launches!.length, f.launches!.length);
    for (const [j, l] of m.launches!.entries()) {
      const g = f.launches![j];
      assert.equal(l.liquidityUsdc, g.liquidityUsdc);
      assert.equal(l.dud, g.dud);
      assert.equal(l.sellBackFrac, g.sellBackFrac);
      assert.equal(g.rampBlocks, undefined);
      // The drawn multiple is the expected total; the realized one scales with the length, so a
      // block's buy is the drawn multiple over the mean length whatever this token's length is.
      if (!l.dud)
        assert.ok(
          Math.abs(l.waveUsdcMult - (g.waveUsdcMult * l.rampBlocks!) / waveLengthMean(0.04, 75)) < 1e-12,
        );
    }
    assert.deepEqual(memoryless.events[1], fixed.events[1], `seed ${seed}: the crash moved`);
  }
});

test("memoryless targets: each token buys over its own length, then holds and sells back from its own stop", () => {
  let checked = 0;
  for (let seed = 1; seed <= 40 && checked < 5; seed++) {
    const s = new EventSchedule([MEMORYLESS({ dudProb: [0, 0], tokenCount: [3, 3] })], seed, 360);
    const ev = s.events[0];
    const ls = ev.launches!;
    if (new Set(ls.map((l) => l.rampBlocks)).size < 2) continue;
    checked++;
    // The window lasts until its longest wave has sold back.
    const longest = Math.max(...ls.map((l) => l.rampBlocks!));
    assert.equal(ev.rampBlocks, longest);
    assert.equal(
      ev.endBlock,
      ev.startBlock + TOKEN_LAUNCH_LEAD_BLOCKS + longest + ev.holdBlocks + ev.decayBlocks,
    );
    const ramp0 = ev.startBlock + TOKEN_LAUNCH_LEAD_BLOCKS;
    for (const [j, l] of ls.entries()) {
      const L = l.rampBlocks!;
      const at = (i: number) => s.tokenLaunchTargetsAt(i)[j];
      assert.equal(at(ramp0 - 1).buyFrac, 0);
      assert.ok(Math.abs(at(ramp0).buyFrac - 1 / L) < 1e-12);
      assert.equal(at(ramp0 + L - 1).buyFrac, 1);
      assert.equal(at(ramp0 - 1).buyBlocks, 0);
      assert.equal(at(ramp0).buyBlocks, 1);
      assert.equal(at(ramp0 + L - 1).buyBlocks, L);
      assert.equal(at(ramp0 + L + 10).buyBlocks, L);
      const decay0 = ramp0 + L + ev.holdBlocks;
      assert.equal(at(decay0 - 1).sellBackFrac, 0);
      assert.ok(Math.abs(at(decay0).sellBackFrac - l.sellBackFrac / ev.decayBlocks) < 1e-12);
      assert.ok(Math.abs(at(decay0 + ev.decayBlocks - 1).sellBackFrac - l.sellBackFrac) < 1e-12);
    }
  }
  assert.equal(checked, 5);
});

test("memoryless funding: no draw spends more than the fixed wave wallet, and the expected total is kept", () => {
  const configs = [MEMORYLESS({ liquidityUsdc: [20_000, 100_000] })];
  const ceiling = tokenLaunchCeiling(configs);
  // The longest wave on the largest pool at the top multiple: 75 / 23.83 x 1.0 x 100k.
  assert.ok(ceiling.waveUsdcUnits > 314_000n * 1_000_000n && ceiling.waveUsdcUnits < 315_000n * 1_000_000n);
  assert.ok(ceiling.waveUsdcUnits <= LAUNCH_WAVE_USDC_UNITS);
  let realized = 0;
  let expected = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const s = new EventSchedule(configs, seed, 360);
    for (const e of tokenLaunchEndowments(s)) assert.ok(e.waveUsdcUnits <= ceiling.waveUsdcUnits);
    for (const l of s.events[0].launches!) {
      if (l.dud) continue;
      realized += l.waveUsdcMult;
      expected += (l.waveUsdcMult * waveLengthMean(0.04, 75)) / l.rampBlocks!;
    }
    // The fixed slots cover every draw, so funding still says nothing about the schedule.
    assert.deepEqual(
      launchWalletFunding(s).map((f) => f.waveUsdcUnits),
      Array(LAUNCH_WALLET_SLOTS).fill(LAUNCH_WAVE_USDC_UNITS),
    );
  }
  assert.ok(Math.abs(realized / expected - 1) < 0.05, `realized / expected ${realized / expected}`);
});

test("a buy says nothing about the length: every block of a memoryless wave buys the same whole amount", () => {
  // The exploit this pins: a block's buy used to be scaleUnits(L x round(realized multiple x 1e6),
  // (t + 1) / r) with the realized multiple proportional to r, so the integer amountIn kept r in its
  // rounding. With L read from the token's supply, the first buy alone left ~3 candidate lengths
  // out of 75 and named r exactly in ~half the waves.
  const doc = parse(readFileSync("config/regimes/launch.yaml", "utf8")) as {
    run: { blocks: number };
    stress: { events: Array<Record<string, unknown>> };
  };
  const parsed = parseStressEvents(JSON.stringify(doc.stress.events));
  let waves = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const s = new EventSchedule(parsed, seed, doc.run.blocks);
    const i = s.events.findIndex((e) => e.type === "tokenLaunch");
    const ev = s.events[i];
    const targets = (b: number) => s.tokenLaunchTargetsAt(b).filter((t) => t.eventIndex === i);
    for (const [j, l] of ev.launches!.entries()) {
      if (l.dud) continue;
      waves++;
      const r = l.rampBlocks!;
      const block = waveBlockUsdcUnits(l)!;
      assert.ok(block > 0n);
      const state = { waveUsdcUnits: waveUsdcUnits(l), waveBlockUsdcUnits: block };
      assert.equal(state.waveUsdcUnits, block * BigInt(r), `seed ${seed}: total is not r blocks`);
      // The same draw with any other length buys the same block.
      for (const other of [1, 2, 24, 75])
        assert.equal(
          waveBlockUsdcUnits({ ...l, rampBlocks: other, waveUsdcMult: l.waveBlockUsdcMult! * other }),
          block,
        );
      // What the driver sends, block by block: one block each time, r times, then nothing.
      const buys: bigint[] = [];
      let spent = 0n;
      for (let b = ev.startBlock; b < ev.endBlock; b++) {
        const target = waveBuyTargetUnits(state, targets(b)[j]);
        if (target > spent) buys.push(target - spent);
        spent = target > spent ? target : spent;
      }
      assert.equal(buys.length, r, `seed ${seed} token ${j}`);
      assert.ok(buys.every((x) => x === block), `seed ${seed} token ${j}: a buy differs from the block`);
      assert.equal(spent, state.waveUsdcUnits);
    }
  }
  assert.ok(waves > 300, `${waves} waves`);
});

test("the price cap ends the wave: nothing more to buy, and the sell-back runs from the stop", () => {
  // It used to wait the cap out with the unbought target piling up: no sell-back while the price
  // stayed up, and the first block back under the cap bought the whole backlog in one swap.
  const doc = parse(readFileSync("config/regimes/launch.yaml", "utf8")) as {
    run: { blocks: number };
    stress: { events: Array<Record<string, unknown>> };
  };
  const parsed = parseStressEvents(JSON.stringify(doc.stress.events));
  let checked = 0;
  for (let seed = 1; seed <= 200 && checked < 20; seed++) {
    const s = new EventSchedule(parsed, seed, doc.run.blocks);
    const i = s.events.findIndex((e) => e.type === "tokenLaunch");
    const ev = s.events[i];
    for (const [j, l] of ev.launches!.entries()) {
      if (l.dud || l.rampBlocks! < 8) continue;
      checked++;
      const block = waveBlockUsdcUnits(l)!;
      const state: Parameters<typeof waveTargets>[0] = {
        launch: l,
        event: ev,
        waveUsdcUnits: waveUsdcUnits(l),
        waveBlockUsdcUnits: block,
        grossBuyUsdc: 0n,
        capStoppedAfter: undefined,
      };
      const ramp0 = ev.startBlock + TOKEN_LAUNCH_LEAD_BLOCKS;
      const stopAt = Math.floor(l.rampBlocks! / 2); // the first block that finds the pool above the cap
      for (let b = ramp0; b < ev.endBlock + 20; b++) {
        const target = s.tokenLaunchTargetsAt(b).filter((t) => t.eventIndex === i)[j];
        const t = b - ramp0;
        if (t === stopAt) state.capStoppedAfter = capStopRamp(state, target);
        const { buyTarget, sellBackFrac } = waveTargets(state, target);
        if (state.capStoppedAfter === undefined) {
          // Before the cap: the schedule's own targets.
          assert.equal(buyTarget, waveBuyTargetUnits(state, target));
          assert.equal(sellBackFrac, target.sellBackFrac);
          state.grossBuyUsdc = buyTarget;
        } else {
          // After it: no backlog, ever, and the sell-back of a wave that stopped after stopAt blocks.
          assert.equal(buyTarget, block * BigInt(stopAt), `seed ${seed} block ${b}`);
          assert.equal(sellBackFrac, launchSellBackFrac(l, t, stopAt, ev.holdBlocks, ev.decayBlocks));
        }
      }
      assert.equal(state.capStoppedAfter, stopAt);
      // The sell-back now starts hold blocks after the stop, not after the drawn length.
      const at = (t: number) =>
        waveTargets(state, s.tokenLaunchTargetsAt(ramp0 + t).filter((x) => x.eventIndex === i)[j]).sellBackFrac;
      assert.equal(at(stopAt + ev.holdBlocks - 1), 0);
      assert.ok(at(stopAt + ev.holdBlocks) > 0);
      assert.ok(Math.abs(at(stopAt + ev.holdBlocks + ev.decayBlocks - 1) - l.sellBackFrac) < 1e-12);
      // A wave still catching up after its ramp keeps its scheduled sell-back.
      const late = s.tokenLaunchTargetsAt(ramp0 + l.rampBlocks! + 3).filter((x) => x.eventIndex === i)[j];
      assert.equal(capStopRamp(state, late), l.rampBlocks);
    }
  }
  assert.ok(checked >= 20, `${checked} waves`);
});

// ---- the secret price ceiling (wavePriceCeiling) ----

test("price ceiling: per token, inside its range, deterministic, and unrelated to anything the field sees first", () => {
  const cfg = MEMORYLESS({ wavePriceCeiling: [1.5, 4] });
  const rows: Array<{ ceiling: number; liquidity: number; block: number; length: number }> = [];
  let differ = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const a = new EventSchedule([cfg], seed, 360).events[0].launches!;
    const b = new EventSchedule([cfg], seed, 360).events[0].launches!;
    assert.deepEqual(a, b, `seed ${seed}`);
    if (new Set(a.map((l) => l.priceCeilingMult)).size === a.length) differ++;
    for (const l of a) {
      assert.ok(l.priceCeilingMult! >= 1.5 && l.priceCeilingMult! <= 4, `seed ${seed}: ${l.priceCeilingMult}`);
      if (!l.dud)
        rows.push({ ceiling: l.priceCeilingMult!, liquidity: l.liquidityUsdc, block: l.waveBlockUsdcMult!, length: l.rampBlocks! });
    }
  }
  assert.equal(differ, 1500, "two tokens of a window shared a ceiling");
  // Uniform on the range: the mean is its middle (sd of U[1.5, 4] is ~0.72).
  const mean = rows.reduce((x, r) => x + r.ceiling, 0) / rows.length;
  assert.ok(Math.abs(mean - 2.75) < (4 * 0.72) / Math.sqrt(rows.length), `mean ${mean}`);
  // Nothing visible before the wave meets the ceiling says where it is: the pool, the per-block
  // size and the length are drawn on other streams.
  const corr = (xs: number[], ys: number[]) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < n; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) ** 2;
      syy += (ys[k] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  };
  const c = rows.map((r) => r.ceiling);
  for (const key of ["liquidity", "block", "length"] as const)
    assert.ok(Math.abs(corr(c, rows.map((r) => r[key]))) < 0.06, `ceiling correlates with ${key}`);
});

test("price ceiling has a stream of its own: the window's other draws, the lengths and later events do not move", () => {
  const crash: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.2, 0.8],
    rampBlocks: 3,
    holdBlocks: 6,
    decayBlocks: 8,
  };
  const opts = { saltWithEventList: false };
  for (let seed = 1; seed <= 30; seed++) {
    const without = new EventSchedule([MEMORYLESS(), crash], seed, 360, 360, opts);
    const withCeiling = new EventSchedule([MEMORYLESS({ wavePriceCeiling: [1.5, 4] }), crash], seed, 360, 360, opts);
    const strip = (ls: typeof without.events[0]["launches"]) =>
      ls!.map(({ priceCeilingMult: _drop, ...rest }) => rest);
    assert.deepEqual(strip(withCeiling.events[0].launches), strip(without.events[0].launches), `seed ${seed}`);
    assert.equal(withCeiling.events[0].startBlock, without.events[0].startBlock);
    assert.deepEqual(withCeiling.events[1], without.events[1], `seed ${seed}: the crash moved`);
    assert.ok(without.events[0].launches!.every((l) => l.priceCeilingMult === undefined));
  }
});

test("the wave stops above its own ceiling, never above the 10x cap, and without one only at the cap", () => {
  assert.equal(waveBuyCapped(1.79, { priceCeilingMult: 1.8 }), false);
  assert.equal(waveBuyCapped(1.81, { priceCeilingMult: 1.8 }), true);
  assert.equal(waveCapUsdcPerToken({ priceCeilingMult: 1.8 }), 1.8);
  // A ceiling above the cap is the cap.
  assert.equal(waveBuyCapped(9.99, { priceCeilingMult: 20 }), false);
  assert.equal(waveBuyCapped(10.01, { priceCeilingMult: 20 }), true);
  assert.equal(waveCapUsdcPerToken({ priceCeilingMult: 20 }), 10);
  // No ceiling drawn: the 10x cap alone, as before.
  assert.equal(waveBuyCapped(9.99), false);
  assert.equal(waveBuyCapped(10.01), true);
  assert.equal(waveCapUsdcPerToken({}), 10);
});

test("parser: wavePriceCeiling is a range above the listing price, on a tokenLaunch only", () => {
  const base = {
    type: "tokenLaunch",
    windowFrac: [0.2, 0.5],
    tokenCount: [2, 3],
    liquidityUsdc: [20000, 100000],
    waveUsdcMult: [0.25, 1],
    dudProb: [0.3, 0.5],
    sellBackFrac: [0.5, 1],
    waveStopProb: 0.04,
    rampBlocks: 75,
    holdBlocks: [24, 36],
    decayBlocks: [28, 36],
    wavePriceCeiling: [1.5, 4],
  };
  assert.deepEqual(parseStressEvents(JSON.stringify([base]))[0].wavePriceCeiling, [1.5, 4]);
  const refuse = (over: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseStressEvents(JSON.stringify([{ ...base, ...over }])), pattern);
  refuse({ wavePriceCeiling: [1, 4] }, /wavePriceCeiling min must be >= 1/);
  refuse({ wavePriceCeiling: [4, 1.5] }, /min <= max/);
  refuse({ wavePriceCeiling: 2 }, /\[min, max\] pair/);
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          { type: "crash", magnitudeRange: [0.1, 0.2], windowFrac: [0.2, 0.5], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8, wavePriceCeiling: [1.5, 4] },
        ]),
      ),
    /wavePriceCeiling only applies/,
  );
});

test("parser: waveStopProb is one probability on a tokenLaunch with a single rampBlocks cap", () => {
  const base = {
    type: "tokenLaunch",
    windowFrac: [0.2, 0.5],
    tokenCount: [2, 3],
    liquidityUsdc: [20000, 100000],
    waveUsdcMult: [0.25, 1],
    dudProb: [0.3, 0.5],
    sellBackFrac: [0.5, 1],
    waveStopProb: 0.04,
    rampBlocks: 75,
    holdBlocks: [24, 36],
    decayBlocks: [28, 36],
  };
  assert.equal(parseStressEvents(JSON.stringify([base]))[0].waveStopProb, 0.04);
  const refuse = (over: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseStressEvents(JSON.stringify([{ ...base, ...over }])), pattern);
  refuse({ waveStopProb: [0.03, 0.05] }, /one number, not a range/);
  refuse({ waveStopProb: 0 }, /strictly between 0 and 1/);
  refuse({ waveStopProb: 1 }, /strictly between 0 and 1/);
  refuse({ rampBlocks: [20, 75] }, /rampBlocks must be one integer/);
  refuse({ rampBlocks: 0 }, /rampBlocks must be one integer/);
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          { type: "crash", magnitudeRange: [0.1, 0.2], windowFrac: [0.2, 0.5], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8, waveStopProb: 0.04 },
        ]),
      ),
    /waveStopProb only applies/,
  );
});

test("endowments: the launch wallet holds the USDC side, the wave wallet its multiple, a dud nothing", () => {
  const s = new EventSchedule([LAUNCH()], 5, 360);
  const endow = tokenLaunchEndowments(s);
  assert.equal(endow.length, s.events[0].launches!.length);
  for (const [i, e] of endow.entries()) {
    const l = s.events[0].launches![i];
    assert.equal(e.slot, i);
    assert.equal(e.launchKey, `launch:${i}`);
    assert.equal(e.waveKey, `launch-wave:${i}`);
    assert.equal(e.liquidityUsdcUnits, BigInt(l.liquidityUsdc) * 1_000_000n);
    if (l.dud) assert.equal(e.waveUsdcUnits, 0n);
    else
      assert.equal(
        e.waveUsdcUnits,
        (BigInt(l.liquidityUsdc) *
          1_000_000n *
          BigInt(Math.round(l.waveUsdcMult * 1e6))) /
          1_000_000n,
      );
  }
  assert.equal(
    waveUsdcUnits({
      index: 0,
      liquidityUsdc: 50_000,
      waveUsdcMult: 1.5,
      dud: false,
      sellBackFrac: 1,
    }),
    75_000_000_000n,
  );
});

test("launch wallets are a fixed set of slots, funded the same whether or not anything lists", () => {
  const floors = Array.from({ length: LAUNCH_WALLET_SLOTS }, (_, slot) => ({
    slot,
    launchKey: `launch:${slot}`,
    waveKey: `launch-wave:${slot}`,
    launchUsdcUnits: LAUNCH_WALLET_USDC_UNITS,
    waveUsdcUnits: LAUNCH_WAVE_USDC_UNITS,
  }));
  // No launch in the schedule: every slot still exists and holds the fixed amounts.
  assert.deepEqual(launchWalletFunding(new EventSchedule([], 5, 360)), floors);
  // Draws inside the fixed amounts change nothing a setup block or a balance would show.
  for (let seed = 1; seed <= 20; seed++) {
    const s = new EventSchedule(
      [LAUNCH({ liquidityUsdc: [20_000, 100_000], waveUsdcMult: [0.25, 1] })],
      seed,
      360,
    );
    assert.deepEqual(launchWalletFunding(s), floors, `seed ${seed}`);
  }
});

test("a draw beyond the fixed amounts is funded rather than capped, and too many tokens refuse", () => {
  const big = new EventSchedule(
    [LAUNCH({ tokenCount: [1, 1], liquidityUsdc: [500_000, 500_000], waveUsdcMult: [2, 2], dudProb: [0, 0] })],
    5,
    360,
  );
  const [slot0] = launchWalletFunding(big);
  assert.equal(slot0.launchUsdcUnits, 500_000n * 1_000_000n);
  assert.equal(slot0.waveUsdcUnits, 1_000_000n * 1_000_000n);
  const many = new EventSchedule(
    [LAUNCH({ tokenCount: [LAUNCH_WALLET_SLOTS + 1, LAUNCH_WALLET_SLOTS + 1] })],
    5,
    360,
  );
  assert.throws(() => launchWalletFunding(many), /launch wallet slots/);
});

test("scaleUnits pins one exact target per fraction", () => {
  assert.equal(scaleUnits(1_000_000n, 0), 0n);
  assert.equal(scaleUnits(1_000_000n, 1), 1_000_000n);
  assert.equal(scaleUnits(1_000_000n, 1.5), 1_000_000n);
  assert.equal(scaleUnits(1_000_000n, 1 / 3), 333_333n);
  assert.equal(scaleUnits(10n ** 18n, 0.123456789), 123456789000000000n);
});

test("parser: tokenLaunch needs its five ranges and refuses a magnitude", () => {
  const base = {
    type: "tokenLaunch",
    windowFrac: [0.2, 0.5],
    tokenCount: [2, 3],
    liquidityUsdc: [20000, 100000],
    waveUsdcMult: [0, 2],
    dudProb: [0.3, 0.5],
    sellBackFrac: [0.5, 1],
    rampBlocks: 9,
    holdBlocks: 30,
    decayBlocks: 30,
  };
  const parsed = parseStressEvents(JSON.stringify([base]))[0];
  assert.equal(parsed.type, "tokenLaunch");
  assert.deepEqual(parsed.magnitudeRange, [0, 0]);
  assert.deepEqual(parsed.tokenCount, [2, 3]);
  assert.deepEqual(parsed.waveUsdcMult, [0, 2]);
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([{ ...base, magnitudeRange: [0.1, 0.2] }]),
      ),
    /magnitudeRange does not apply/,
  );
  for (const key of [
    "tokenCount",
    "liquidityUsdc",
    "waveUsdcMult",
    "dudProb",
    "sellBackFrac",
  ]) {
    const { [key]: _dropped, ...rest } = base as Record<string, unknown>;
    assert.throws(
      () => parseStressEvents(JSON.stringify([rest])),
      new RegExp(`${key} is required`),
    );
  }
  assert.throws(
    () =>
      parseStressEvents(JSON.stringify([{ ...base, tokenCount: [1.5, 3] }])),
    /integer range/,
  );
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...base, dudProb: [0.3, 1.5] }])),
    /dudProb max/,
  );
  // The launch ranges belong to no other type.
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          {
            type: "crash",
            magnitudeRange: [0.1, 0.2],
            windowFrac: [0.2, 0.5],
            rampBlocks: 3,
            holdBlocks: 6,
            decayBlocks: 8,
            dudProb: [0, 1],
          },
        ]),
      ),
    /dudProb only applies/,
  );
});

// The committed regime and the scenario sets that carry it.
test("config/regimes/launch.yaml: a tokenLaunch window on a registry-enabled, all-venue run", () => {
  const doc = parse(readFileSync("config/regimes/launch.yaml", "utf8")) as {
    run: { blocks: number; protocols: string[]; localDeploy: boolean };
    agentMarkets: { enabled: boolean };
    stress: { events: Array<Record<string, unknown>> };
    agents: Array<{ id: string }>;
  };
  assert.equal(doc.run.blocks, 360);
  assert.equal(doc.run.localDeploy, true);
  assert.ok(doc.run.protocols.includes("uniswap"));
  assert.equal(doc.agentMarkets.enabled, true);
  const launch = doc.stress.events.find((e) => e.type === "tokenLaunch");
  assert.ok(launch, "no tokenLaunch event");
  // The regime's ranges parse; the wave's length is memoryless; and on every seed each wave's
  // sell-back starts with room to exit before it and long before the bell. (The decay itself may
  // run later: a holder who is still in by then has missed the exit, not the run.)
  const parsed = parseStressEvents(JSON.stringify(doc.stress.events));
  const tl = parsed.find((e) => e.type === "tokenLaunch")!;
  assert.equal(typeof tl.waveStopProb, "number");
  assert.ok(tl.wavePriceCeiling, "launch.yaml has no secret price ceiling");
  for (let seed = 1; seed <= 200; seed++) {
    const s = new EventSchedule(parsed, seed, doc.run.blocks);
    const ev = s.events.find((e) => e.type === "tokenLaunch")!;
    assert.ok(ev.endBlock <= doc.run.blocks, `seed ${seed}: window ends at ${ev.endBlock}`);
    for (const l of ev.launches!) {
      assert.ok(
        l.priceCeilingMult! >= tl.wavePriceCeiling![0] && l.priceCeilingMult! <= tl.wavePriceCeiling![1],
        `seed ${seed}: ceiling ${l.priceCeilingMult}`,
      );
      const sellBack =
        ev.startBlock + TOKEN_LAUNCH_LEAD_BLOCKS + l.rampBlocks! + ev.holdBlocks;
      assert.ok(sellBack <= doc.run.blocks - 60, `seed ${seed}: a sell-back starts at ${sellBack}`);
    }
  }
  // The most any seed can draw stays inside the fixed wave wallet (also held for every official
  // regime by test/regimeStartInvariance.test.ts).
  assert.ok(tokenLaunchCeiling(parsed).waveUsdcUnits <= LAUNCH_WAVE_USDC_UNITS);
  assert.ok(doc.agents.some((a) => a.id === "launch-sniper"));
  assert.ok(doc.agents.some((a) => a.id === "launch-confirm"));
});

test("the public set carries launch, and its size stays a multiple of the regime count", () => {
  const pub = parse(readFileSync("config/scenarios/public.yaml", "utf8")) as {
    regimes: string[];
    seeds: number[];
  };
  assert.ok(pub.regimes.includes("launch"));
  assert.equal(pub.regimes.length, 12);
  const k = pub.regimes.length * pub.seeds.length;
  assert.equal(k % pub.regimes.length, 0);
  const roster = parse(
    readFileSync("config/rosters/full-field.yaml", "utf8"),
  ) as {
    agents: Array<{ id: string }>;
  };
  assert.ok(roster.agents.some((a) => a.id === "launch-sniper"));
  assert.ok(roster.agents.some((a) => a.id === "launch-confirm"));
});
