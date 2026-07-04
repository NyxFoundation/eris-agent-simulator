// 取引前のコントラクト検証（ADR 0014 §4,5）。二段構え:
//   1. dry-run（決定論・安価）: 実行予定 swap を eth_call で空打ちし、実出力 vs honest 見積り
//      （getAmountOut）を比較。乖離があれば rigged（サイズ閾値付き rig も実サイズで空打ちすれば捕捉）。
//   2. LLM ソース監査（条件付き/隠蔽 rig 用・任意）: dry-run が通っても、配布 verified source
//      （codehash 照合済み）＋挙動証拠を LLM に渡し、probe をすり抜ける条件付き rig / backdoor を
//      読み取らせる。verdict は参考ログ（採点は環境 ground-truth。ADR 0014 §6）。
//
// ソース入手（§5）: シミュレーションでは環境が runs/<id>/disclosures/<addr>.json を配布する。
// agent は eth_getCode(address) の codehash を配布レコードと照合し「source == 実 bytecode」を確かめる。
// 本番では explorer API に差し替えるだけ（source 取得を IF 化。competition bundle 互換）。
//
// verdict は address 単位でキャッシュ（コントラクトは immutable なので run 中不変）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { vulnAmmAbi } from "./vulnAbi.js";

export type VerifyStatus = "safe" | "unsafe" | "unknown";

export type LlmVerdict = {
  safe: boolean;
  reason: string;
  confidence: number;
  error?: string;
};

export type VerifyResult = {
  status: VerifyStatus;
  reason: string;
  checks: {
    disclosureFound: boolean;
    codehashMatch: boolean | null; // null = 配布レコード無し（unverified）
    dryRun: "ok" | "skim" | "revert" | "skipped";
    quotedOut?: string;
    simOut?: string;
    llm?: LlmVerdict | null;
  };
};

type Disclosure = {
  address: string;
  sourceCode: string;
  contractName?: string;
  compiler?: string;
  codehash: string;
};

// 最終判定（safe/unsafe）のみキャッシュ。unknown（approval 未着で dry-run revert）はキャッシュしない。
const cache = new Map<string, VerifyResult>();

function readDisclosure(
  runDir: string | undefined,
  address: Address,
): Disclosure | null {
  if (!runDir) return null;
  try {
    const path = join(runDir, "disclosures", `${address.toLowerCase()}.json`);
    return JSON.parse(readFileSync(path, "utf8")) as Disclosure;
  } catch {
    return null; // 未配布（本番 explorer なら unverified）
  }
}

export type VerifyOptions = {
  publicClient: PublicClient;
  pool: Address;
  tokenIn: Address; // = USDC（base を買う）
  amountIn: bigint; // 実際に取引予定のサイズ（サイズ閾値 rig を実サイズで捕捉するため）
  trader: Address; // 自分（dry-run の msg.sender）
  runDir?: string; // ERIS_RUN_DIR（disclosures の基点）
  llmMode?: string; // ERIS_VULN_LLM: "0"|"1"|"mock"
};

export async function verifyContract(
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const key = opts.pool.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const checks: VerifyResult["checks"] = {
    disclosureFound: false,
    codehashMatch: null,
    dryRun: "skipped",
    llm: null,
  };

  // 1) codehash 照合（配布 source が実 bytecode と一致するか）。
  const disclosure = readDisclosure(opts.runDir, opts.pool);
  const code =
    (await opts.publicClient.getCode({ address: opts.pool })) ?? "0x";
  const onchainHash = keccak256(code as Hex);
  if (disclosure) {
    checks.disclosureFound = true;
    checks.codehashMatch =
      disclosure.codehash.toLowerCase() === onchainHash.toLowerCase();
    if (!checks.codehashMatch) {
      // source が嘘（red flag）。取引しない。
      return final(key, {
        status: "unsafe",
        reason: "codehash mismatch: disclosed source != on-chain bytecode",
        checks,
      });
    }
  }

  // 2) dry-run: 実サイズで swap を eth_call し、honest 見積りとの乖離（skim）を捕捉。
  let quotedOut: bigint | undefined;
  try {
    quotedOut = (await opts.publicClient.readContract({
      address: opts.pool,
      abi: vulnAmmAbi,
      functionName: "getAmountOut",
      args: [opts.amountIn, opts.tokenIn],
    })) as bigint;
    checks.quotedOut = quotedOut.toString();
  } catch {
    quotedOut = undefined;
  }
  // honest 見積りが読めないと skim 比較ができない = 検証不能。safe と誤って minOut=0 で取引する
  // fail-open を避けるため unknown を返す（agent 側で再試行させる）。
  if (quotedOut === undefined) {
    return {
      status: "unknown",
      reason: "getAmountOut read failed; cannot compare dry-run output",
      checks,
    };
  }
  try {
    const { result } = await opts.publicClient.simulateContract({
      address: opts.pool,
      abi: vulnAmmAbi,
      functionName: "swap",
      args: [opts.amountIn, 0n, opts.tokenIn, opts.trader],
      account: opts.trader,
    });
    const simOut = result as bigint;
    checks.simOut = simOut.toString();
    if (quotedOut > 0n) {
      // honest なら simOut == quotedOut。skim があれば simOut < quotedOut。
      if (simOut * 10_000n < quotedOut * 9_950n) {
        checks.dryRun = "skim";
        return final(key, {
          status: "unsafe",
          reason: `dry-run skim: simOut(${simOut}) < quotedOut(${quotedOut})`,
          checks,
        });
      }
    }
    checks.dryRun = "ok";
  } catch (error) {
    // approval 未着 / 資金不足などで transferFrom が revert すると dry-run できない。
    // 断定できないので unknown（agent 側で approve 後に再試行させる）。
    checks.dryRun = "revert";
    return {
      status: "unknown",
      reason: `dry-run reverted: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      checks,
    };
  }

  // 3) LLM ソース監査（任意・defense in depth）。dry-run が通っても source を読ませる。
  if (disclosure && opts.llmMode && opts.llmMode !== "0") {
    const verdict = await auditContractWithLlm(
      disclosure.sourceCode,
      {
        quotedOut: checks.quotedOut ?? "",
        simOut: checks.simOut ?? "",
        amountIn: opts.amountIn.toString(),
      },
      opts.llmMode,
    );
    checks.llm = verdict;
    if (verdict && !verdict.safe && verdict.confidence >= 0.6) {
      return final(key, {
        status: "unsafe",
        reason: `llm audit flagged: ${verdict.reason}`,
        checks,
      });
    }
  }

  return final(key, {
    status: "safe",
    reason:
      "dry-run matched honest quote" +
      (disclosure ? " + verified source" : " (unverified)"),
    checks,
  });
}

function final(key: string, r: VerifyResult): VerifyResult {
  cache.set(key, r);
  return r;
}

// -------- LLM 監査（ADR 0014 §4-2。src/llm の env 慣習を流用。既定 off） --------
//   "mock": source を静的走査するスタブ（テスト/デモ用・決定論）。
//   "1"   : ollama HTTP（ERIS_OLLAMA_* / ERIS_LLM_MODEL）で JSON verdict を得る。
export async function auditContractWithLlm(
  source: string,
  probe: { quotedOut: string; simOut: string; amountIn: string },
  mode: string,
): Promise<LlmVerdict | null> {
  if (!mode || mode === "0") return null;
  if (mode === "mock") {
    // 条件付き skim の**構造**を静的に探す: 「amountIn 閾値超で out を減算する条件分岐」。
    // コメント/変数名でなくロジック（`if (amountIn > …)` かつ `out = out * …`）に依存させる
    // （honest 側の "skim しない" 等のコメントで誤検知しない。配布 source はコメント除去済みだが二重防御）。
    const rigged =
      /if\s*\(\s*amountIn\s*>/.test(source) &&
      /out\s*=\s*\(?\s*out\s*\*/.test(source);
    return rigged
      ? {
          safe: false,
          reason:
            "swap に amountIn 閾値超で out を減らす条件付き分岐がある（getAmountOut には無い）",
          confidence: 0.9,
        }
      : {
          safe: true,
          reason: "conditional skim 分岐は見つからない",
          confidence: 0.8,
        };
  }
  // mode === "1"（実 LLM: ollama）
  try {
    return await ollamaAudit(source, probe);
  } catch (error) {
    // LLM は補助。失敗しても dry-run が一次検証なのでブロックしない。
    return {
      safe: true,
      reason: "llm unavailable",
      confidence: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ollamaAudit(
  source: string,
  probe: { quotedOut: string; simOut: string; amountIn: string },
): Promise<LlmVerdict> {
  const apiKey =
    process.env.ERIS_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";
  const baseUrl = process.env.ERIS_OLLAMA_BASE_URL ?? "https://ollama.com/api";
  const model =
    process.env.ERIS_OLLAMA_MODEL ??
    process.env.ERIS_LLM_MODEL ??
    "gpt-oss:120b";
  const system =
    "あなたはスマートコントラクト監査 AI。与えられた AMM プールの Solidity ソースと dry-run 証拠から、" +
    "swap が見積り(getAmountOut)より少なくしか渡さない条件付き rug / backdoor があるか判定する。" +
    'JSON のみで {"safe": bool, "reason": string, "confidence": number(0..1)} を返す。';
  const user =
    `SOURCE:\n${source}\n\nPROBE: quotedOut=${probe.quotedOut} simOut=${probe.simOut} amountIn=${probe.amountIn}\n` +
    "この swap を実行して安全か？条件付き skim 分岐があれば safe=false。";
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "{}";
  const parsed = JSON.parse(content) as Partial<LlmVerdict>;
  return {
    safe: parsed.safe ?? true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
  };
}
