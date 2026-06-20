import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { TOKENS } from "../src/constants.js";
import type { RunLogger } from "../src/logger.js";
import { toPriceFeedAnswer } from "../src/realtime/priceFeed.js";
import {
  readValueSnapshotAtBlock,
  reconstructValueSeries,
} from "../src/realtime/reconstruct.js";
import { agentColor, classifyAgent } from "../src/dashboard/labels.js";
import { DashboardState } from "../src/dashboard/state.js";

// 断面 multicall を決定論で返す fake（uniswap/aave/gmx 無効 → head=latestAnswer のみ、
// agent あたり ETH + WETH + stable の 3 本）。RPC モック基盤が無い reconstruct を
// 「呼び出し構造 + 価値計算の不変」で固定する（ADR 0008 P0 担保）。
const FAIR = 3000;
const AGENT = {
  id: "a1",
  address: "0x1111111111111111111111111111111111111111" as const,
};

test("readValueSnapshotAtBlock: spot 価値を断面から計算（uniswap 無効で poolPrice=null）", async () => {
  let calls = 0;
  const client = {
    // biome-ignore lint/suspicious/noExplicitAny: テスト fake
    async multicall({ contracts }: any) {
      calls++;
      // biome-ignore lint/suspicious/noExplicitAny: テスト fake
      return contracts.map((c: any) => {
        if (c.functionName === "latestAnswer")
          return { status: "success", result: toPriceFeedAnswer(FAIR) };
        if (c.functionName === "getEthBalance")
          return { status: "success", result: 0n };
        if (c.functionName === "balanceOf") {
          const isWeth =
            String(c.address).toLowerCase() ===
            TOKENS.WETH.address.toLowerCase();
          return {
            status: "success",
            result: isWeth ? 2n * 10n ** 18n : 1000n * 10n ** 6n,
          };
        }
        return { status: "failure" };
      });
    },
  } as unknown as PublicClient;

  const snap = await readValueSnapshotAtBlock({
    publicClient: client,
    agents: [AGENT],
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x2222222222222222222222222222222222222222",
    blockNumber: 100,
  });

  assert.equal(snap.blockNumber, 100);
  assert.equal(snap.fairPriceUsdcPerWeth, FAIR);
  assert.equal(snap.poolPriceUsdcPerWeth, null);
  assert.equal(snap.values.length, 1);
  // usdc 1000 + (eth0 + weth2)*3000 = 7000
  assert.equal(snap.values[0].id, "a1");
  assert.equal(snap.values[0].valueUsdc, 7000);
  assert.equal(calls, 1);
});

test("reconstructValueSeries: ブロックごとに 1 agent 1 observation を emit（抽出後も不変な形）", async () => {
  const client = {
    // biome-ignore lint/suspicious/noExplicitAny: テスト fake
    async multicall({ contracts }: any) {
      // biome-ignore lint/suspicious/noExplicitAny: テスト fake
      return contracts.map((c: any) => {
        if (c.functionName === "latestAnswer")
          return { status: "success", result: toPriceFeedAnswer(FAIR) };
        if (c.functionName === "getEthBalance")
          return { status: "success", result: 0n };
        if (c.functionName === "balanceOf") {
          const isWeth =
            String(c.address).toLowerCase() ===
            TOKENS.WETH.address.toLowerCase();
          return {
            status: "success",
            result: isWeth ? 2n * 10n ** 18n : 1000n * 10n ** 6n,
          };
        }
        return { status: "failure" };
      });
    },
  } as unknown as PublicClient;

  const events: Record<string, unknown>[] = [];
  const logger = {
    event: (e: Record<string, unknown>) => events.push(e),
  } as unknown as RunLogger;

  const meta = await reconstructValueSeries({
    publicClient: client,
    logger,
    agents: [AGENT],
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x2222222222222222222222222222222222222222",
    fromBlock: 10,
    toBlock: 12,
  });

  assert.equal(meta.blocks, 3);
  assert.equal(meta.failedReads, 0);
  assert.equal(events.length, 3);
  const first = events[0] as {
    type: string;
    agentId: string;
    observation: {
      reconstructed: boolean;
      round: number;
      blockNumber: string;
      fairPriceUsdcPerWeth: number;
      inventory: { valueUsdc: number };
    };
  };
  assert.equal(first.type, "observation");
  assert.equal(first.agentId, "a1");
  assert.equal(first.observation.reconstructed, true);
  assert.equal(first.observation.round, 10);
  assert.equal(first.observation.blockNumber, "10");
  assert.equal(first.observation.fairPriceUsdcPerWeth, FAIR);
  assert.equal(first.observation.inventory.valueUsdc, 7000);
});

test("classifyAgent: mixed30 の命名規約を kind/base/index に分類", () => {
  assert.deepEqual(classifyAgent("si-codex-01-crossvenue"), {
    kind: "si",
    base: "crossvenue",
    index: 1,
  });
  assert.deepEqual(classifyAgent("si-codex-15-statarb"), {
    kind: "si",
    base: "statarb",
    index: 15,
  });
  assert.deepEqual(classifyAgent("fix-crossvenue-2"), {
    kind: "frozen",
    base: "crossvenue-2",
    index: 2,
  });
  assert.deepEqual(classifyAgent("fix-fairmm"), {
    kind: "frozen",
    base: "fairmm",
    index: null,
  });
  assert.equal(classifyAgent("random", { baseline: true }).kind, "baseline");
  assert.equal(classifyAgent("noop").kind, "baseline");
});

test("DashboardState: stress scenario / liquidation を SSE + snapshot に載せる（ADR 0009）", () => {
  const state = new DashboardState();
  const msgs: Array<{ event: string; data: unknown }> = [];
  state.on("message", (m) => msgs.push(m));

  state.setScenario({
    name: "crash",
    runStartBlock: 100,
    events: [{ type: "crash", startBlock: 30, endBlock: 47, magnitude: 0.12 }],
  });
  state.recordLiquidation({
    blockNumber: 132,
    victimId: "victim-0",
    repaidBaseUsd: 3_310_00000000, // USD 8 桁
    healthFactor: "955000000000000000",
    ts: 1000,
  });

  // SSE: scenario / liquidation が emit される
  const scenarioMsg = msgs.find((m) => m.event === "scenario");
  const liqMsg = msgs.find((m) => m.event === "liquidation");
  assert.ok(scenarioMsg, "scenario message emitted");
  assert.equal((scenarioMsg!.data as { name: string }).name, "crash");
  assert.ok(liqMsg, "liquidation message emitted");
  assert.equal((liqMsg!.data as { victimId: string }).victimId, "victim-0");

  // snapshot にも同梱される（新規接続向けフル状態）
  const snap = state.snapshot();
  assert.equal((snap.scenario as { name: string }).name, "crash");
  assert.equal((snap.scenario as { runStartBlock: number }).runStartBlock, 100);
  const liqs = snap.liquidations as Array<{ victimId: string; ts: number }>;
  assert.equal(liqs.length, 1);
  assert.equal(liqs[0].victimId, "victim-0");
  assert.equal(liqs[0].ts, 1000);

  // 未注入 run では scenario は null
  assert.equal(new DashboardState().snapshot().scenario, null);
});

test("agentColor: kind ごとに色相帯が分かれ、同 id は安定", () => {
  const si = agentColor("si-codex-01-crossvenue", "si");
  const frozen = agentColor("fix-crossvenue", "frozen");
  const baseline = agentColor("noop", "baseline");
  assert.match(si, /^hsl\(/);
  assert.notEqual(si, frozen);
  assert.equal(agentColor("si-codex-01-crossvenue", "si"), si); // 決定論
  assert.equal(baseline, "hsl(220 6% 62%)");
});
