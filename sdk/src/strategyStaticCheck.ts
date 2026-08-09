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
