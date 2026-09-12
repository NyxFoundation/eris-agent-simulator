import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  EventSchedule,
  parseStressEvents,
  type StressEventConfig,
} from "../core/src/realtime/events.js";
import {
  scaleUnits,
  tokenLaunchEndowments,
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
    assert.equal(ev.endBlock, 108 + 69);
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
  assert.ok(Math.abs(at(ev.startBlock).buyFrac - 1 / 9) < 1e-12);
  assert.equal(at(ev.startBlock + 8).buyFrac, 1);
  assert.equal(at(ev.startBlock + 20).buyFrac, 1);
  assert.equal(at(ev.startBlock + 20).sellBackFrac, 0);
  const decayStart = ev.startBlock + 9 + 30;
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

test("endowments: the launch wallet holds the USDC side, the wave wallet its multiple, a dud nothing", () => {
  const s = new EventSchedule([LAUNCH()], 5, 360);
  const endow = tokenLaunchEndowments(s);
  assert.equal(endow.length, s.events[0].launches!.length);
  for (const [i, e] of endow.entries()) {
    const l = s.events[0].launches![i];
    assert.equal(e.launchKey, `launch:0:${i}`);
    assert.equal(e.waveKey, `launch-wave:0:${i}`);
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
  // The regime's ranges parse, and the window fits the run with room to exit afterwards.
  const parsed = parseStressEvents(JSON.stringify(doc.stress.events));
  const s = new EventSchedule(parsed, 101, doc.run.blocks);
  const ev = s.events.find((e) => e.type === "tokenLaunch")!;
  assert.ok(
    ev.endBlock <= doc.run.blocks - 60,
    `window ends at ${ev.endBlock}`,
  );
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
