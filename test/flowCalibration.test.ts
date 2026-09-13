// The local registry includes WBTC. No chain is needed: the context builder reads funded balances
// from a client stub, while YAML loading, cap selection and order generation use the real paths.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { SimContext } from "@eris/sdk/protocols/types.js";

const { loadConfig } = await import("@eris/sdk/config.js");
const { buildSource } = await import("@eris/sdk/runConfig.js");
const { buildFlowContext } = await import("../core/src/coordinator.js");
const { buildFlowOrders } = await import("../core/src/flow/logic.js");
const { Rng } = await import("@eris/sdk/rng.js");
const { setActiveBases } = await import("@eris/sdk/chain.js");
const { baseTokens } = await import("@eris/sdk/markets.js");
setActiveBases(baseTokens().map(token => token.address));

const official = ["calm", "cex-drift", "crash", "depeg", "depeg-persist", "informed-flow",
  "lending-incident", "spike", "vuln", "whale", "cdp-incident", "launch"];

for (const regime of official) {
  test(`${regime}: WBTC funding and per-venue caps match WETH at opening fair prices`, () => {
    const config = loadConfig(buildSource(parse(readFileSync(`config/regimes/${regime}.yaml`, "utf8"))));
    const wethUsd = (amount: bigint) => amount * 3000n / 10n ** 18n;
    const wbtcUsd = (amount: bigint) => amount * 60000n / 10n ** 8n;
    assert.equal(wbtcUsd(config.flowBaseAmounts.WBTC), wethUsd(config.flowWethWei));
    assert.equal(wbtcUsd(config.baseInformedFlowMax.WBTC), wethUsd(config.informedFlowMaxWethWei));
    for (const cap of [config.uninformedFlowMaxWethWei, config.balancerFlowMaxWethWei, config.curveFlowMaxWethWei]) {
      assert.equal(wbtcUsd(config.baseFlowMax.WBTC), wethUsd(cap));
    }
  });
}

async function context(flow: Record<string, unknown>) {
  const config = loadConfig(buildSource({ flow, funding: { flowWethWei: "150000000000000000000" } }));
  const ctx = {
    config,
    fairPrices: { WBTC: 60000 },
    publicClient: { getBalance: async () => 10n ** 22n, readContract: async () => 10n ** 22n },
    flowWallet: () => ({ address: "0x0000000000000000000000000000000000000001" }),
  } as unknown as SimContext;
  const venues = ["uniswap", "balancer", "curve"] as const;
  return buildFlowContext(ctx, [...venues], new Map(venues.map(id => [id, {
    priceUsdcPerWeth: 3000,
    markets: [{ market: { base: "WBTC" }, priceUsdcPerWeth: 61000 }],
  }])), 3000, 1);
}

test("the optional WBTC informed cap defaults to the shared cap and only overrides Uniswap", async () => {
  const shared = { baseMax: { WBTC: "5000000" } };
  const old = await context(shared);
  const next = await context({ ...shared, baseInformedMax: { WBTC: "10000000" } });
  assert.equal(old.extraBases![0].informedFlowMaxBaseWei, "5000000");
  const orders = (ctx: typeof old) => buildFlowOrders(new Rng(1), ctx)
    .filter(o => o.kind === "informed" && (o.action as { base?: string }).base === "WBTC");
  const before = orders(old);
  const after = orders(next);
  assert.equal(before.length, 3);
  assert.equal(after.length, 3);
  for (let i = 0; i < before.length; i++) {
    const a = before[i].action as { type: string; amountIn: string };
    const b = after[i].action as { amountIn: string };
    assert.equal(BigInt(b.amountIn), BigInt(a.amountIn) * (before[i].protocol === "uniswap" ? 2n : 1n));
  }
});

test("an explicit zero disables Uniswap informed flow without disabling other venues", async () => {
  const ctx = await context({ baseMax: { WBTC: "5000000" }, baseInformedMax: { WBTC: "0" } });
  const informed = buildFlowOrders(new Rng(1), ctx)
    .filter(o => o.kind === "informed" && (o.action as { base?: string }).base === "WBTC");
  assert.equal(informed.length, 2);
  assert.ok(informed.every(o => o.protocol !== "uniswap"));
});

test("an informed-only cap enables the base and an entirely disabled base is omitted", async () => {
  const ctx = await context({ baseInformedMax: { WBTC: "10000000" } });
  const orders = buildFlowOrders(new Rng(1), ctx)
    .filter(o => (o.action as { base?: string }).base === "WBTC");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].kind, "informed");
  assert.equal(orders[0].protocol, "uniswap");
  assert.equal((await context({})).extraBases, undefined);
});
