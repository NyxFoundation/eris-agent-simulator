// verifyContract の mock ソース監査（ADR 0014 §4-2）の純関数テスト。
// 実チェーン非依存。狙いは「honest 側のコメント（"skim しない" 等）で誤検知しないこと」を固定する
// こと — 監査はコメント/変数名でなく swap の構造（amountIn 閾値超で out を減算する条件分岐）で判定する。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditContractWithLlm } from "../example/agents/lib/verifyContract.js";

const ROOT = resolve(import.meta.dirname, "..");
const riggedSrc = readFileSync(
  resolve(ROOT, "contracts/RiggedAMM.sol"),
  "utf8",
);
const simpleSrc = readFileSync(
  resolve(ROOT, "contracts/SimpleAMM.sol"),
  "utf8",
);
const probe = { quotedOut: "1000", simOut: "540", amountIn: "5000" };

test("mock audit: RiggedAMM の条件付き skim を rigged と判定", async () => {
  const v = await auditContractWithLlm(riggedSrc, probe, "mock");
  assert.ok(v && v.safe === false, `${JSON.stringify(v)}`);
});

test("mock audit: SimpleAMM は safe（'skim しない' コメントで誤検知しない）", async () => {
  const v = await auditContractWithLlm(simpleSrc, probe, "mock");
  assert.ok(v && v.safe === true, `${JSON.stringify(v)}`);
});

test("mock audit: コメント除去後も判定は不変（構造ベース）", async () => {
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const vr = await auditContractWithLlm(strip(riggedSrc), probe, "mock");
  const vs = await auditContractWithLlm(strip(simpleSrc), probe, "mock");
  assert.ok(vr && vr.safe === false);
  assert.ok(vs && vs.safe === true);
});

test("mock audit: mode '0' は null（skip）", async () => {
  assert.equal(await auditContractWithLlm(riggedSrc, probe, "0"), null);
});
