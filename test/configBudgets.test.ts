// Every place a rate meets a finite budget, checked against the numbers this repository ships.
//
// The background flow's wallets had this shape and nobody saw it: the informed leg's per-block cap
// and the amount the wallets are funded with were chosen independently, demand came to ~3.7x supply,
// and the gap-closing side went quiet for most of every refill cycle. Each of the fixes before it
// (#99, #112, #124, #130) got a test at the function it touched, and every one of those tests still
// passes -- the failure lived between two subsystems that no test put in the same place.
//
// So this file is organised by the *pair*, not by the module: a rate, a budget, and the horizon they
// have to agree over. Several of the pairs below are split across packages -- the burn rate is a
// config knob and the budget is a deployer constant -- which is exactly how one of them drifts
// without anyone editing a line that looks wrong.
//
// Deployer constants are read out of the source rather than imported: `deployer/` is a self-contained
// package outside the workspace (CLAUDE.md), and a regex that stops matching is a loud failure here
// rather than a silent default.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { rewardRatePerBlockRay, rewardRunway } from "../sdk/src/protocols/lst.js";

const WAD = 10n ** 18n;
const OFFICIAL = (
  parse(readFileSync("config/scenarios/public.yaml", "utf8")) as {
    regimes: string[];
  }
).regimes;
const FILES = [
  ...OFFICIAL.map((n) => `config/regimes/${n}.yaml`),
  "config/practice.yaml",
];

type Doc = {
  run: { blocks?: number; blockTimeSec?: number; protocols?: string[] };
  funding?: { wethWei?: string };
  lst?: { simulatedSecondsPerBlock?: number; apyBps?: number };
  stress?: {
    liquityVictimCount?: number;
    liquityVictimIcr?: number;
    liquityVictimCollWethWei?: string;
  };
  agents?: unknown[];
};

const load = (path: string): Doc => parse(readFileSync(path, "utf8")) as Doc;

/** A number written as a literal in a deployer source file, with the match asserted. */
function deployerConstant(file: string, name: string): bigint {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(
    `const ${name} = (?:parseUnits\\("([0-9_.]+)", *([0-9]+)\\)|([0-9_]+)n)`,
  ).exec(src);
  assert.ok(m, `${file}: const ${name} is no longer a literal this test can read`);
  if (m![3] !== undefined) return BigInt(m![3].replace(/_/g, ""));
  const [whole, frac = ""] = m![1].replace(/_/g, "").split(".");
  const decimals = Number(m![2]);
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

// ------------------------------------------------- LST yield against its reserve (issue #129)
//
// rate x pooled WETH is paid out of a reserve the deployer stakes once. With the clock at one hour a
// block a 35-day period was 170 years of yield and the 50 WETH reserve lasted 3.3 days; ADR 0028 put
// the clock back on the chain's own. lstReserve.test.ts checks the arithmetic on inputs of its own
// choosing -- this checks the inputs.

const LST_RESERVE_WEI = deployerConstant(
  "deployer/src/protocols/lst.ts",
  "REWARD_RESERVE",
);
const LST_POOL_WEI = deployerConstant(
  "deployer/src/protocols/lst.ts",
  "POOL_WETH",
);

test("the deployer still seeds the LST vault with the amounts this file reasons about", () => {
  assert.equal(LST_RESERVE_WEI, 50n * WAD);
  assert.equal(LST_POOL_WEI, 100n * WAD);
});

for (const path of FILES) {
  const doc = load(path);
  if (!doc.run.protocols?.includes("lst")) continue;

  test(`${path}: the LST yield clock is the chain's own (ADR 0028)`, () => {
    // The knob that broke it. A regime that compresses the clock is not wrong in itself -- the venue
    // tests do it on purpose -- but it then owes the reserve check below a reserve to match, and no
    // official config has ever wanted one.
    assert.equal(
      doc.lst?.simulatedSecondsPerBlock,
      undefined,
      "an official config sets lst.simulatedSecondsPerBlock; it inherits run.blockTimeSec",
    );
  });

  // Load-bearing on the practice horizon, where it reproduces #129 exactly: put the clock back to
  // 3,600 s and this reads "runway 84,883 blocks against a 1,814,400-block horizon" -- about two
  // days of a six-week period, which is what was measured. On a 360-block official epoch the 50 WETH
  // reserve is over-provisioned by orders of magnitude and nothing short of an absurd rate moves it,
  // so there the check above is the one doing the work.
  test(`${path}: the reward reserve outlasts the run, with the whole field staked`, () => {
    const secondsPerBlock = doc.lst?.simulatedSecondsPerBlock ?? doc.run.blockTimeSec ?? 2;
    const apyBps = doc.lst?.apyBps ?? 300;
    // Pessimistic pool: the deployer's stake plus every agent staking its whole WETH endowment. A
    // bigger pool pays more per block, so this is the short end of the runway, not the long one.
    const agents = BigInt(doc.agents?.length ?? 0);
    const pooled = LST_POOL_WEI + agents * BigInt(doc.funding?.wethWei ?? "0");
    const { runwayBlocks } = rewardRunway(
      rewardRatePerBlockRay(apyBps, secondsPerBlock),
      LST_RESERVE_WEI,
      pooled,
      pooled,
    );
    // A practice period states no block count; it runs on `endsAt`. 42 days at 2 s is the longest
    // one that has been scheduled, which is the horizon to clear.
    const horizon = doc.run.blocks && doc.run.blocks > 0 ? doc.run.blocks : 42 * 24 * 60 * 30;
    assert.ok(
      runwayBlocks !== null && runwayBlocks >= horizon,
      `runway ${runwayBlocks} blocks at ${apyBps} bps on a ${secondsPerBlock} s clock ` +
        `with ${pooled / WAD} WETH pooled, against a ${horizon}-block horizon`,
    );
  });
}

// --------------------------- Liquity: the Stability Pool against the victims it has to absorb
//
// A Trove below MCR is only liquidated while the Stability Pool can take its whole debt (and in
// Recovery Mode that is the only way it is liquidated at all). The pool is seeded once by the
// deployer and the cohort is sized by each regime, so a regime that stages more victims -- or
// heavier ones -- stops its own liquidations without anything saying so.

const SP_SEED_EUSD = deployerConstant(
  "deployer/src/protocols/liquity.ts",
  "STABILITY_POOL_EUSD",
);
const GENESIS_PRICE_USD = deployerConstant(
  "deployer/src/protocols/liquity.ts",
  "GENESIS_PRICE_USD",
);

test("the deployer still seeds the Stability Pool with the amount this file reasons about", () => {
  assert.equal(SP_SEED_EUSD, 125_000n);
  assert.equal(GENESIS_PRICE_USD, 3000n);
});

for (const path of FILES) {
  const doc = load(path);
  const count = doc.stress?.liquityVictimCount ?? 0;
  if (!doc.run.protocols?.includes("liquity") || count <= 0) continue;

  test(`${path}: the Stability Pool can absorb the whole victim cohort`, () => {
    // What the pool offsets is the Trove's *whole* debt, gas compensation included -- not the amount
    // the borrower asked for (`victimDebtForIcr`, which is that minus the fee and the gas comp). So
    // the number here comes straight from Liquity's ICR identity, debt = coll x price / ICR.
    const collWei = BigInt(
      doc.stress?.liquityVictimCollWethWei ?? (5n * WAD).toString(),
    );
    const icr = doc.stress?.liquityVictimIcr ?? 1.2;
    const icrWad = BigInt(Math.round(icr * 1e6)) * (WAD / 1_000_000n);
    const debt = (collWei * GENESIS_PRICE_USD * WAD) / icrWad;
    const cohort = (debt * BigInt(count)) / WAD;
    assert.ok(
      cohort <= SP_SEED_EUSD,
      `${count} victims owe ${cohort} eUSD against a ${SP_SEED_EUSD} eUSD pool: ` +
        `their liquidations would not execute`,
    );
  });
}

// ------------------------------------------------------ the pairs this repository knows about
//
// A registry, so that adding a rate against a finite budget is a conscious act rather than two
// edits in two packages. Every row names where the rate lives, where the budget lives, and what
// checks that they still agree.

const PAIRS: Array<{
  pair: string;
  rate: string;
  budget: string;
  checkedBy: string;
}> = [
  {
    pair: "background flow: informed (gap-closing) orders against the flow wallets",
    rate: "flow.informedMaxWethWei / flow.baseInformedMax, every block past a 5 % deviation",
    budget: "funding.flowWethWei / flowUsdcUnits / flowBase, refilled on flow.topUpEveryBlocks",
    checkedBy: "test/flowInformedBudget.test.ts",
  },
  {
    pair: "background flow: a flowTrend lean against the flow wallets",
    rate: "flow.uninformedMaxWethWei x the window's magnitude and length",
    budget: "funding.flowWethWei / flowUsdcUnits",
    checkedBy: "test/flowTrendInventory.test.ts",
  },
  {
    pair: "background flow: the GMX leg against each side's open-interest cap",
    rate: "flow.gmxFlowMaxSizeUsd x flow.gmxOiTargetFrac",
    budget: "the market's reserve factor x pool value",
    checkedBy: "test/flowGmxOiTarget.test.ts",
  },
  {
    pair: "LST: the staking yield against the reward reserve",
    rate: "lst.apyBps on lst.simulatedSecondsPerBlock, x the pooled WETH",
    budget: "deployer/src/protocols/lst.ts REWARD_RESERVE",
    checkedBy: "test/configBudgets.test.ts",
  },
  {
    pair: "Liquity: the victim cohort's debt against the Stability Pool",
    rate: "stress.liquityVictimCount x liquityVictimCollWethWei at liquityVictimIcr",
    budget: "deployer/src/protocols/liquity.ts STABILITY_POOL_EUSD",
    checkedBy: "test/configBudgets.test.ts",
  },
];

test("every known rate-and-budget pair names a check that exists", () => {
  for (const p of PAIRS)
    assert.ok(existsSync(p.checkedBy), `${p.pair}: ${p.checkedBy} is missing`);
  assert.equal(
    new Set(PAIRS.map((p) => p.pair)).size,
    PAIRS.length,
    "two rows describe the same pair",
  );
});
