// Pre-trade contract verification (ADR 0014 §4,5). Two stages:
//   1. dry-run (deterministic, cheap): dry-fire the swap you intend to execute via eth_call and
//      compare actual output vs the honest quote (getAmountOut). A discrepancy means rigged (a
//      size-threshold rig is also caught by dry-firing at the actual size).
//   2. LLM source audit (for conditional/hidden rigs; optional): even if the dry-run passes, hand the
//      distributed verified source (codehash-matched) plus the behavioral evidence to an LLM to read
//      out a conditional rig / backdoor that slips past the probe. The verdict is a reference log
//      (scoring is the environment's ground truth; ADR 0014 §6).
//
// Obtaining source (§5): in simulation the environment distributes runs/<id>/disclosures/<addr>.json.
// The agent matches the codehash from eth_getCode(address) against the distributed record to confirm
// "source == actual bytecode". In production just swap in an explorer API (source fetching behind an
// interface; competition-bundle compatible).
//
// The verdict is cached per address (contracts are immutable, so it's fixed during the run).
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
    codehashMatch: boolean | null; // null = no distributed record (unverified)
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

// Cache only final verdicts (safe/unsafe). Do not cache unknown (dry-run revert because the approval hasn't landed).
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
    return null; // not distributed (unverified under a production explorer)
  }
}

export type VerifyOptions = {
  publicClient: PublicClient;
  pool: Address;
  tokenIn: Address; // = USDC (buy the base)
  amountIn: bigint; // the size you actually intend to trade (to catch a size-threshold rig at the actual size)
  trader: Address; // yourself (the dry-run's msg.sender)
  runDir?: string; // ERIS_RUN_DIR (base of disclosures)
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

  // 1) codehash match (does the distributed source match the actual bytecode?).
  const disclosure = readDisclosure(opts.runDir, opts.pool);
  const code =
    (await opts.publicClient.getCode({ address: opts.pool })) ?? "0x";
  const onchainHash = keccak256(code as Hex);
  if (disclosure) {
    checks.disclosureFound = true;
    checks.codehashMatch =
      disclosure.codehash.toLowerCase() === onchainHash.toLowerCase();
    if (!checks.codehashMatch) {
      // the source is lying (red flag). Do not trade.
      return final(key, {
        status: "unsafe",
        reason: "codehash mismatch: disclosed source != on-chain bytecode",
        checks,
      });
    }
  }

  // 2) dry-run: eth_call the swap at the actual size and catch the discrepancy (skim) vs the honest quote.
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
  // If the honest quote can't be read, the skim comparison is impossible = not verifiable. Return
  // unknown to avoid a fail-open where it's wrongly deemed safe and traded with minOut=0 (let the agent retry).
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
      // if honest, simOut == quotedOut. If there's a skim, simOut < quotedOut.
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
    // If transferFrom reverts (approval not landed / insufficient funds etc.), the dry-run isn't possible.
    // Can't conclude, so unknown (let the agent retry after approve).
    checks.dryRun = "revert";
    return {
      status: "unknown",
      reason: `dry-run reverted: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      checks,
    };
  }

  // 3) LLM source audit (optional, defense in depth). Have it read the source even if the dry-run passed.
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

// -------- LLM audit (ADR 0014 §4-2; reuses src/llm's env conventions; default off) --------
//   "mock": a stub that statically scans the source (for tests/demos, deterministic).
//   "1"   : get a JSON verdict via ollama HTTP (ERIS_OLLAMA_* / ERIS_LLM_MODEL).
export async function auditContractWithLlm(
  source: string,
  probe: { quotedOut: string; simOut: string; amountIn: string },
  mode: string,
): Promise<LlmVerdict | null> {
  if (!mode || mode === "0") return null;
  if (mode === "mock") {
    // Statically look for the *structure* of a conditional skim: "a conditional branch that subtracts
    // from out above an amountIn threshold". Depend on the logic (`if (amountIn > …)` and `out = out * …`),
    // not comments/variable names (so an honest-side comment like "no skim" won't false-positive; the
    // distributed source has comments stripped, but this is a second layer of defense).
    const rigged =
      /if\s*\(\s*amountIn\s*>/.test(source) &&
      /out\s*=\s*\(?\s*out\s*\*/.test(source);
    return rigged
      ? {
          safe: false,
          reason:
            "swap has a conditional branch that reduces out above an amountIn threshold (not present in getAmountOut)",
          confidence: 0.9,
        }
      : {
          safe: true,
          reason: "no conditional skim branch found",
          confidence: 0.8,
        };
  }
  // mode === "1" (real LLM: ollama)
  try {
    return await ollamaAudit(source, probe);
  } catch (error) {
    // The LLM is auxiliary. Even on failure, don't block, since the dry-run is the primary verification.
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
    "You are a smart-contract auditing AI. From the given AMM pool's Solidity source and dry-run evidence, " +
    "judge whether there is a conditional rug / backdoor where swap delivers less than the quote (getAmountOut). " +
    'Return only JSON: {"safe": bool, "reason": string, "confidence": number(0..1)}.';
  const user =
    `SOURCE:\n${source}\n\nPROBE: quotedOut=${probe.quotedOut} simOut=${probe.simOut} amountIn=${probe.amountIn}\n` +
    "Is it safe to execute this swap? If there is a conditional skim branch, safe=false.";
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
