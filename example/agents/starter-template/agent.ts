// ASCON starter template — copy this folder, rename it, and fill in `decide()`.
//
//   cp -r example/agents/starter-template example/agents/my-strategy
//
// Full tutorial: docs/guide/writing-agents.md. Participant quickstart: docs/guide/participant-quickstart.md.
// The whole contract is the `decide()` function below: it runs once per block, reads a snapshot of
// confirmed state (`obs`), and returns ONE action (or a `bundle`), or `null`/`noop` to sit out.
// Invalid actions are rejected before signing (fail-closed) — they never reach the chain.
import type { AgentAction, AgentObservation } from "@eris/sdk";
import type { AgentContext } from "@eris/sdk/agent.js";

// Optional. Omit to be called once per new block (recommended for the competition: 1 block = 1 decision).
// export const config = { intervalMs: 5000 };

export function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): AgentAction | Record<string, unknown> | null {
  // --- 1. Read the snapshot (never trust a field is present; treat missing as "unknown") ---
  const fair = obs.fairPriceUsdcPerWeth;                    // environment fair price (1 block late by design)
  const pool = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth; // Uniswap WETH/USDC mid
  if (!fair || !pool) {
    ctx.log({ round: obs.round, action: { type: "noop" }, reason: "no fair/pool price yet" });
    return null;
  }

  // --- 2. Your signal (TODO: replace this toy "buy when the pool is cheap vs fair" rule) ---
  const gapBps = (fair / pool - 1) * 10000;                 // >0 means the pool is below fair (WETH is cheap)
  const THRESHOLD_BPS = 50;                                 // TODO: tune / replace with your own edge

  if (gapBps <= THRESHOLD_BPS) {
    ctx.log({ round: obs.round, action: { type: "noop" }, signals: { fair, pool, gapBps }, reason: "no edge" });
    return null;
  }

  // --- 3. Size the trade yourself (there is NO per-order cap; the only bounds are your wallet
  //   balance and the venue depth you are willing to move — see AgentObservation.limits doc).
  //   Amounts are decimal STRINGS in native units: USDC = 6 decimals, WETH = 18 decimals. Use BigInt.
  const budgetUsdc = BigInt(obs.balances?.usdcUnits ?? "0");
  const amountIn = budgetUsdc / 4n;  // TODO: your own sizing (here: a quarter of the USDC budget)
  if (amountIn <= 0n) {
    ctx.log({ round: obs.round, action: { type: "noop" }, reason: "no USDC budget" });
    return null;
  }

  // --- 4. Return the action. Put reasoning in ctx.log, NOT in the action (only noop carries a reason). ---
  const action: AgentAction = {
    type: "swap",                                           // Uniswap WETH/USDC swap
    tokenIn: "USDC",
    amountIn: amountIn.toString(),
    slippageBps: 75,                                        // TODO: tune
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
  } as AgentAction;

  // Competition limit: at most 3 tx per block (regola §2.6; block gas limit 320M). The operator also
  // enforces the per-block tx cap and a per-tx gas cap before signing. To send more than one leg atomically,
  // use { type: "bundle", actions: [...] } (GMX cannot be bundled).
  ctx.log({ round: obs.round, action, signals: { fair, pool, gapBps }, reason: "pool below fair — buying WETH" });
  return action;
}
