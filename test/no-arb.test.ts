import test from "node:test";
import assert from "node:assert/strict";
import type { ProtocolId } from "@eris/sdk/types.js";
import {
  bestExecutableArb,
  NoArbMonitor,
  noArbFindings,
  PERSIST_BLOCKS,
  PERSIST_WARN_BPS,
  venueExecQuotes,
  type ArbFinding,
} from "../core/src/realtime/noArb.js";

const ENABLED: ProtocolId[] = ["uniswap", "balancer", "curve"];

// Hand-built adapter states (the structural slice noArb reads). uniswap carries the fee in the
// market config; balancer/curve carry the two-sided executable quote (or the legacy sell quote).
function states(opts: {
  uniMid?: number;
  balSell?: number;
  balBuy?: number;
  curveLegacySell?: number;
}): Map<ProtocolId, unknown> {
  const m = new Map<ProtocolId, unknown>();
  if (opts.uniMid !== undefined) {
    m.set("uniswap", {
      markets: [
        {
          market: { base: "WETH", uniswap: { fee: 3000 } },
          priceUsdcPerWeth: opts.uniMid,
        },
      ],
    });
  }
  if (opts.balSell !== undefined && opts.balBuy !== undefined) {
    m.set("balancer", {
      markets: [
        {
          market: { base: "WETH" },
          priceUsdcPerWeth: Math.sqrt(opts.balSell * opts.balBuy),
          sellPriceUsdcPerWeth: opts.balSell,
          buyPriceUsdcPerWeth: opts.balBuy,
          effectiveHalfSpreadBps:
            (Math.sqrt(opts.balBuy / opts.balSell) - 1) * 10_000,
        },
      ],
    });
  }
  if (opts.curveLegacySell !== undefined) {
    m.set("curve", {
      markets: [
        {
          market: { base: "WETH" },
          priceUsdcPerWeth: opts.curveLegacySell,
        },
      ],
    });
  }
  return m;
}

test("venueExecQuotes: two-sided fields take precedence; uniswap/legacy synthesize from mid±fee", () => {
  const byBase = venueExecQuotes(
    states({
      uniMid: 3000,
      balSell: 2991,
      balBuy: 3009,
      curveLegacySell: 2991,
    }),
    ENABLED,
  );
  const quotes = byBase["WETH"]!;
  const uni = quotes.find((q) => q.venue === "uniswap")!;
  assert.ok(Math.abs(uni.sellPx - 3000 * 0.997) < 1e-9);
  assert.ok(Math.abs(uni.buyPx - 3000 / 0.997) < 1e-9);
  const bal = quotes.find((q) => q.venue === "balancer")!;
  assert.equal(bal.sellPx, 2991);
  assert.equal(bal.buyPx, 3009);
  const curve = quotes.find((q) => q.venue === "curve")!;
  assert.equal(curve.sellPx, 2991); // legacy price IS the sell quote
  assert.ok(Math.abs(curve.buyPx - 2991 / 0.997 ** 2) < 1e-9);
});

test("bestExecutableArb: healthy calibrated venues yield a negative best profit", () => {
  const byBase = venueExecQuotes(
    states({ uniMid: 3000, balSell: 2991, balBuy: 3009 }),
    ENABLED,
  );
  const best = bestExecutableArb("WETH", byBase["WETH"]!)!;
  assert.ok(
    best.profitBps < 0,
    `expected negative profit, got ${best.profitBps}`,
  );
});

test("bestExecutableArb: a mispriced venue surfaces as positive executable profit", () => {
  // balancer trades ~200bps above uniswap: sell on balancer > buy on uniswap.
  const byBase = venueExecQuotes(
    states({ uniMid: 3000, balSell: 3051, balBuy: 3069 }),
    ENABLED,
  );
  const best = bestExecutableArb("WETH", byBase["WETH"]!)!;
  assert.equal(best.buyVenue, "uniswap");
  assert.equal(best.sellVenue, "balancer");
  const expected = (3051 / (3000 / 0.997) - 1) * 10_000;
  assert.ok(Math.abs(best.profitBps - expected) < 0.01);
});

test("noArbFindings: sorted worst-first and skips single-venue bases", () => {
  const m = states({ uniMid: 3000, balSell: 3051, balBuy: 3069 });
  // Add a WBTC market on uniswap only (1 venue -> no finding).
  (m.get("uniswap") as { markets: unknown[] }).markets.push({
    market: { base: "WBTC", uniswap: { fee: 3000 } },
    priceUsdcPerWeth: 60000,
  });
  const findings = noArbFindings(m, ENABLED);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].base, "WETH");
});

test("NoArbMonitor: warns only after PERSIST_BLOCKS consecutive violations, then every PERSIST_BLOCKS", () => {
  const monitor = new NoArbMonitor();
  const violating: ArbFinding[] = [
    {
      base: "WBTC",
      buyVenue: "uniswap",
      sellVenue: "curve",
      profitBps: PERSIST_WARN_BPS + 25,
    },
  ];
  for (let i = 1; i < PERSIST_BLOCKS; i++) {
    assert.equal(monitor.check(violating).length, 0, `block ${i}`);
  }
  const warned = monitor.check(violating);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].consecutiveBlocks, PERSIST_BLOCKS);
  // Continues violating -> re-warn exactly at the next boundary.
  for (let i = 1; i < PERSIST_BLOCKS; i++) {
    assert.equal(monitor.check(violating).length, 0);
  }
  assert.equal(
    monitor.check(violating)[0]!.consecutiveBlocks,
    PERSIST_BLOCKS * 2,
  );
});

test("NoArbMonitor: dropping below the threshold resets the streak", () => {
  const monitor = new NoArbMonitor();
  const violating: ArbFinding[] = [
    { base: "WETH", buyVenue: "a", sellVenue: "b", profitBps: 80 },
  ];
  const healthy: ArbFinding[] = [
    { base: "WETH", buyVenue: "a", sellVenue: "b", profitBps: -20 },
  ];
  for (let i = 1; i < PERSIST_BLOCKS; i++) monitor.check(violating);
  monitor.check(healthy); // reset one block before the boundary
  for (let i = 1; i < PERSIST_BLOCKS; i++) {
    assert.equal(monitor.check(violating).length, 0);
  }
  assert.equal(monitor.check(violating).length, 1);
});
