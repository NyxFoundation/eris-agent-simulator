// discovery-arb-verify (ADR 0014 §6): discovery + pre-trade verification + execution (careful).
// Uses the same discovery layer as discovery-arb, but audits candidate pools before trading via
// verifyContract (dry-run + codehash match + optional LLM source audit). Rejects rigged pools
// (vulnerability_avoided) and only trades safe new pools with a protective minOut (safe_pool_captured).
// The discrimination between "detection only" and "detection + verification" reduces to the presence
// of this verification gate alone.
//
// Subscribes to blocks and emits actions itself: the run(ctx) contract (ADR 0015 §3). Delegates to the shared core.
import type { AgentContext } from "@eris/sdk";
import { runDiscoveryAgent } from "../lib/discoveryAgent.js";

export async function run(ctx: AgentContext): Promise<void> {
  await runDiscoveryAgent(ctx, { verify: true });
}
