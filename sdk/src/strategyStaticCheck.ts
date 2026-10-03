// Static analysis of strategy code (ADR 0006 §5, ADR 0018 §2).
//
// An agent talks to anvil directly, so it could in principle cheat through the unauthenticated
// cheatcode RPCs (anvil_setBalance / evm_mine / anvil_impersonateAccount, ...). The submission gate
// (`npm run check:strategy`) runs this over participant code as an entry-side defense, paired with
// post-run auditing.
//
// It lives in the sdk rather than in core because both sides need it: core runs it as a gate, and
// the agent runtime (example/agents/runtime) runs it on **LLM-generated executor code before
// installing it** (ADR 0018). Generated code is the case the original comment anticipated -- once an
// LLM authors the strategy, "self-written agent = trusted" stops holding -- and example cannot
// import core (the dependency direction is example -> sdk <- core).
export type StaticCheckFinding = {
  line: number; // 1-based
  match: string;
  rule: string;
};

const CHEAT_PATTERNS: Array<{ rule: string; regex: RegExp }> = [
  { rule: "anvil cheatcode RPC", regex: /\banvil_[a-zA-Z]+/ },
  { rule: "evm cheatcode RPC", regex: /\bevm_[a-zA-Z]+/ },
  { rule: "hardhat cheatcode RPC", regex: /\bhardhat_[a-zA-Z]+/ },
  {
    rule: "privileged chain.ts helper (environment-only)",
    regex:
      /\b(setEthBalance|dealErc20|impersonate|stopImpersonate|sendAsImpersonated|setIntervalMining|setAutomine|setNonce|resetFork)\b/,
  },
];

function scan(
  source: string,
  patterns: Array<{ rule: string; regex: RegExp }>,
): StaticCheckFinding[] {
  const findings: StaticCheckFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { rule, regex } of patterns) {
      const match = lines[i].match(regex);
      if (match) findings.push({ line: i + 1, match: match[0], rule });
    }
  }
  return findings;
}

/**
 * The gate: a line that names a cheatcode or a privileged helper. A finding here fails
 * `npm run check:strategy` and rejects an LLM-written revision.
 *
 * What it cannot see (issue #216 (5)): a method name assembled at runtime.
 * `["anvil", "setBalance"].join("_")` contains no `anvil_` and passes. That is a limit of any
 * line-level check, and it is why the gate is one of three layers rather than the boundary: the
 * runtime's read-only client and the gateway refuse the assembled name when it is *sent*, and the
 * post-run audit reads what landed. `findAssembledCheatcodeHints` names the cheap shapes of that
 * assembly for a reviewer; it is reported, not enforced.
 */
export function findCheatcodeUsage(source: string): StaticCheckFinding[] {
  return scan(source, CHEAT_PATTERNS);
}

// Shapes a runtime-assembled cheatcode name tends to take. Each is a hint, not a verdict: the first
// fires on a log message that happens to quote "anvil", the third on any computed RPC method. And the
// list is not complete -- `"anv" + "il_setBalance"` matches none of them. That is the point of
// keeping these out of the gate: a pattern list that claimed to close the hole would be the hole.
const HINT_PATTERNS: Array<{ rule: string; regex: RegExp }> = [
  {
    rule: "cheatcode namespace as a string on its own (assembled method name?)",
    regex: /["'`](?:anvil|evm|hardhat)_?["'`]/,
  },
  {
    rule: "RPC method name that is not a string literal",
    // `method: m`, `method: names[i]`, `method: f()` -- but not `method: "eth_call"`, and not a
    // type annotation (`method: string`).
    regex: /\bmethod\s*:\s*(?!["'`]|string\b|number\b|unknown\b|any\b)[A-Za-z_$(\[]/,
  },
  {
    rule: "string built from character codes or base64",
    regex: /String\.fromCharCode|\batob\s*\(|from\([^)]*,\s*["'`]base64["'`]\)/,
  },
];

/**
 * Hints that a cheatcode name may be assembled rather than written (issue #216 (5)). Never fails
 * the gate: `scripts/checkStrategyCode.ts` prints them for the operator and the submission scanner
 * files them as WARN. Incomplete by construction; see HINT_PATTERNS.
 */
export function findAssembledCheatcodeHints(
  source: string,
): StaticCheckFinding[] {
  return scan(source, HINT_PATTERNS);
}
