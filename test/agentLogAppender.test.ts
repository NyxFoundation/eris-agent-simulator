// agentLog.ts の createJsonlAppender（suffix 付き別ファイル追記 = LLM 対話ログ用）のテスト。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlAppender } from "../example/agents/runtime/agentLog.js";

test("createJsonlAppender: suffix 付きで <agentId><suffix>.jsonl へ追記する", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-agentlog-"));
  const append = createJsonlAppender(dir, "my-arb", ".llm");
  append({ kind: "llm_system", revision: 0 });
  append({ kind: "llm_call", purpose: "decision", round: 1 });
  const path = join(dir, "agents", "my-arb.llm.jsonl");
  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].agentId, "my-arb");
  assert.equal(lines[0].kind, "llm_system");
  assert.equal(lines[1].purpose, "decision");
  assert.ok(lines[1].ts); // タイムスタンプが付与される
  // 行動ログ本体（suffix なし）とはファイルが分かれる
  assert.equal(existsSync(join(dir, "agents", "my-arb.jsonl")), false);
});

test("createJsonlAppender: runDir 無し（coordinator 配下でない）は no-op", () => {
  const append = createJsonlAppender(undefined, "x", ".llm");
  append({ a: 1 }); // throw しないこと
});
