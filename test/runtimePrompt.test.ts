import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRevisionSystem,
  buildRevisionUser,
  buildSystemPrompt,
  buildUserMessage,
  loadPromptAgent,
} from "../example/agents/runtime/prompt.js";
import type { AgentObservation } from "../sdk/src/types.js";

function writePrompt(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-prompt-"));
  writeFileSync(join(dir, "prompt.md"), content);
  return dir;
}

test("loadPromptAgent: frontmatter（name/description 必須 + 任意フィールド）を読む", () => {
  const dir = writePrompt(
    [
      "---",
      "name: my-arb",
      "description: cross-venue 裁定",
      "intervalMs: 4000",
      "model: gpt-oss:120b",
      "unknownField: ignored", // 前方互換: 未知フィールドは無視
      "---",
      "あなたは裁定 bot。",
      "",
    ].join("\n"),
  );
  const agent = loadPromptAgent(dir);
  assert.equal(agent.name, "my-arb");
  assert.equal(agent.description, "cross-venue 裁定");
  assert.equal(agent.intervalMs, 4000);
  assert.equal(agent.model, "gpt-oss:120b");
  assert.equal(agent.body, "あなたは裁定 bot。");
});

test("loadPromptAgent: name 欠落は明示エラー", () => {
  const dir = writePrompt(
    ["---", "description: x", "---", "body", ""].join("\n"),
  );
  assert.throws(() => loadPromptAgent(dir), /"name" は必須/);
});

test("loadPromptAgent: frontmatter 無しは明示エラー", () => {
  const dir = writePrompt("body only\n");
  assert.throws(() => loadPromptAgent(dir), /frontmatter/);
});

test("buildSystemPrompt: <schema> + 環境ルール + prompt.md 本文を合成する（Hermes 形式）", () => {
  const dir = writePrompt(
    [
      "---",
      "name: t",
      "description: d",
      "---",
      "STRATEGY_BODY_MARKER",
      "",
    ].join("\n"),
  );
  const agent = loadPromptAgent(dir);
  const system = buildSystemPrompt(agent, ["uniswap"]);
  assert.match(system, /<schema>/);
  assert.match(system, /<\/schema>/);
  assert.match(system, /Environment rules/);
  assert.match(system, /STRATEGY_BODY_MARKER/);
  // enabled venue 絞り込みが <schema> に反映される
  assert.doesNotMatch(system, /balancerSwap/);
});

test("buildUserMessage: observation と直近の行動を埋める", () => {
  const obs = {
    kind: "observation",
    round: 12,
    fairPriceUsdcPerWeth: 3000,
  } as unknown as AgentObservation;
  const msg = buildUserMessage(obs, [
    { round: 11, action: { type: "noop" }, note: "skipped" },
  ]);
  assert.match(msg, /round 12/);
  assert.match(msg, /"fairPriceUsdcPerWeth":3000/);
  assert.match(msg, /round=11/);
  assert.match(msg, /skipped/);
});

test("buildRevisionSystem/User: 自己改善プロンプトが規律・証拠・現行本文を含む", () => {
  const dir = writePrompt(
    ["---", "name: rev-t", "description: d", "---", "OLD_BODY_MARKER", ""].join(
      "\n",
    ),
  );
  const agent = loadPromptAgent(dir);
  const system = buildRevisionSystem(agent);
  assert.match(system, /rev-t/);
  assert.match(system, /Revision discipline/);
  assert.match(system, /Output ONLY the new prompt body/);

  const user = buildRevisionUser(
    agent.body,
    [{ round: 5, action: { type: "noop" }, note: "skipped" }],
    {
      cycles: 12,
      initialValueUsdc: 1000,
      currentValueUsdc: 990.5,
      recentRevertRate: 0.25,
      recentSampleSize: 8,
    },
  );
  assert.match(user, /OLD_BODY_MARKER/);
  assert.match(user, /12 decision cycles/);
  assert.match(user, /1000\.00 -> 990\.50 USDC/);
  assert.match(user, /25% over last 8 txs/);
  assert.match(user, /round=5/);
});

test("buildRevisionUser: 観測前・約定前は placeholder を出す", () => {
  const user = buildRevisionUser("BODY", [], {
    cycles: 0,
    initialValueUsdc: null,
    currentValueUsdc: null,
  });
  assert.match(user, /\(not yet observed\)/);
  assert.match(user, /\(no included txs yet\)/);
  assert.match(user, /\(none\)/);
});
