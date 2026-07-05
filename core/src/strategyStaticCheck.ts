// Static analysis of strategy code (ADR 0006 §5).
// In direct mode the agent touches the anvil RPC directly, so it can in principle
// cheat via unauthenticated cheatcodes (anvil_setBalance / evm_mine /
// anvil_impersonateAccount, etc.). When an LLM authors strategy code, "self-written
// agent = trusted" no longer holds, so the /strategy-evolve gate includes a
// mechanical check that generated/edited strategy code contains no cheatcode calls,
// as an entry-side defense (paired with post-run auditing).
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
      /\b(setEthBalance|dealErc20|impersonate|stopImpersonate|sendAsImpersonated|setIntervalMining|setAutomine|resetFork)\b/,
  },
];

export function findCheatcodeUsage(source: string): StaticCheckFinding[] {
  const findings: StaticCheckFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { rule, regex } of CHEAT_PATTERNS) {
      const match = lines[i].match(regex);
      if (match) findings.push({ line: i + 1, match: match[0], rule });
    }
  }
  return findings;
}
