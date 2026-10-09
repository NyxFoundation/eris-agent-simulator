// Issue #274: what the revision context calls the PnL.
//
// The observation's inventory.valueUsdc priced WBTC at zero (observationFor passed the WETH price
// alone) and never contained a venue position, so the model read posted collateral as money lost.
// These tests pin the two halves of the fix: the wallet prices every base, and the runtime adds every
// venue the way the summary does -- or reports no value at all, never a partial one.
//
// Under the local-deploy overlay, the only registry that knows WBTC. The env is set before the
// dynamic import below; Node's test runner gives each file its own process.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import type { ProtocolAdapter, SimContext } from "@eris/sdk/protocols/types.js";
import type { SimConfig } from "@eris/sdk/config.js";
import { AccountValue } from "../example/agents/runtime/accountValue.js";
import type { ChainSnapshot } from "../example/agents/runtime/read.js";

const { observationFor } = await import("@eris/sdk/observation.js");

const AGENT = "0x1234567890abcdef1234567890abcdef12345678" as const;

test("observationFor prices every base in inventory.valueUsdc, not WETH alone (#274)", async () => {
  const ctx = {
    publicClient: {},
    fairPrices: { WETH: 3_000, WBTC: 60_000 },
  } as unknown as SimContext;
  const config = {
    defaultPriorityFeeWei: 1n,
    maxPriorityFeeWei: 5_000_000_000n,
    economicGas: false,
  } as unknown as SimConfig;
  const obs = await observationFor(
    ctx,
    [],
    new Map(),
    "test",
    1,
    1n,
    AGENT,
    3_000,
    {
      ethWei: 0n,
      wethWei: 2n * 10n ** 18n,
      usdcUnits: 1_000_000_000n,
      // The basket's 0.4 WBTC: 24,000 USDC at the fair price above.
      bases: { WETH: 2n * 10n ** 18n, WBTC: 40_000_000n },
    },
    [],
    config,
    [],
  );
  // 2 WETH x 3,000 + 0.4 WBTC x 60,000 + 1,000 USDC.
  assert.equal(obs.inventory.valueUsdc, 31_000);
});

type FakeVenue = {
  id: string;
  valueUsdc: (ctx: SimContext) => Promise<number>;
};

function venues(list: FakeVenue[]): ProtocolAdapter[] {
  return list as unknown as ProtocolAdapter[];
}

function snapshot(walletUsdc: number, fair: Record<string, number>): ChainSnapshot {
  return {
    observation: {
      inventory: { valueUsdc: walletUsdc, weth: 0, usdc: 0, eth: 0 },
      fairPricesUsd: fair,
    },
    balances: {},
    stateById: new Map(),
    fairPrice: fair.WETH,
  } as unknown as ChainSnapshot;
}

test("AccountValue adds every venue to the wallet, at the snapshot's own fair prices (#274)", async () => {
  const seen: Array<Record<string, number> | undefined> = [];
  const ctx = { fairPrices: { WETH: 1, WBTC: 1 } } as unknown as SimContext;
  const account = new AccountValue({
    ctx,
    address: AGENT,
    adapters: venues([
      // GMX collateral and PnL, and Aave supply net of debt: both outside the wallet.
      { id: "gmx", valueUsdc: async (c) => (seen.push(c.fairPrices), 1_500) },
      { id: "aave", valueUsdc: async () => 2_500 },
      { id: "curve", valueUsdc: async () => 0 },
    ]),
  });
  const mark = await account.mark(10, snapshot(20_000, { WETH: 3_000, WBTC: 60_000 }));
  assert.deepEqual(mark, { block: 10, valueUsdc: 24_000, venuesUsdc: 4_000 });
  assert.deepEqual(account.first(), mark);
  assert.deepEqual(account.latest(), mark);
  // The venue read is priced at the block it values, not at whatever the shared context says now.
  assert.deepEqual(seen, [{ WETH: 3_000, WBTC: 60_000 }]);
  assert.deepEqual(ctx.fairPrices, { WETH: 1, WBTC: 1 });
});

test("AccountValue gives a block no value when any venue read fails, rather than a partial one (#274)", async () => {
  const errors: string[] = [];
  const account = new AccountValue({
    ctx: {} as SimContext,
    address: AGENT,
    adapters: venues([
      { id: "gmx", valueUsdc: async () => 1_500 },
      {
        id: "liquity",
        valueUsdc: async () => {
          throw new Error("execution reverted");
        },
      },
    ]),
    onError: (block, venue) => errors.push(`${block}:${venue}`),
  });
  assert.equal(await account.mark(7, snapshot(20_000, { WETH: 3_000 })), null);
  assert.deepEqual(errors, ["7:liquity"]);
  assert.equal(account.stats().failed, 1);
  assert.equal(account.first(), null);
  assert.equal(account.latest(), null);
});

test("AccountValue drops a total whose venue reads ran after the chain moved on (#274)", async () => {
  // The wallet half is block 9's; the venue reads go to the head. If block 10 (with this agent's own
  // deposit in it) landed while they ran, the deposit would be counted in both halves.
  let head = 9n;
  const account = new AccountValue({
    ctx: {} as SimContext,
    address: AGENT,
    adapters: venues([
      {
        id: "aave",
        valueUsdc: async () => {
          head = 10n;
          return 5_000;
        },
      },
    ]),
    headBlock: async () => head,
  });
  assert.equal(await account.mark(9, snapshot(20_000, { WETH: 3_000 })), null);
  assert.equal(account.latest(), null);
  assert.equal(account.stats().stale, 1);
  // At the head: kept.
  assert.deepEqual(await account.mark(10, snapshot(15_000, { WETH: 3_000 })), {
    block: 10,
    valueUsdc: 20_000,
    venuesUsdc: 5_000,
  });
});

test("AccountValue values one block at a time and never moves latest backwards (#274)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const account = new AccountValue({
    ctx: {} as SimContext,
    address: AGENT,
    adapters: venues([
      {
        id: "gmx",
        valueUsdc: async () => {
          calls += 1;
          if (calls === 1) await gate;
          return 100;
        },
      },
    ]),
  });
  const slow = account.mark(5, snapshot(1_000, { WETH: 3_000 }));
  // Arrives while block 5 is still out: skipped, not queued behind it.
  assert.equal(await account.mark(6, snapshot(1_000, { WETH: 3_000 })), null);
  release();
  assert.equal((await slow)?.block, 5);
  assert.equal(calls, 1);
  await account.mark(8, snapshot(1_200, { WETH: 3_000 }));
  // A late answer for an older block does not replace a newer one.
  await account.mark(7, snapshot(900, { WETH: 3_000 }));
  assert.equal(account.latest()?.block, 8);
  assert.equal(account.first()?.block, 5);
  assert.deepEqual(account.stats(), { valued: 3, skipped: 1, stale: 0, failed: 0 });
});
