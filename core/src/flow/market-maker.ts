/**
 * market-maker: the default orderflow bot (independent process).
 *
 * Receives a FlowContext (one JSON line) from the coordinator each round on stdin,
 * generates uninformed noise + informed (pull price toward fair) orders with its own
 * seeded RNG, and returns FlowOrder[] as one line on stdout.
 *
 * Environment variables:
 *   ERIS_FLOW_SEED  seed for the deterministic RNG (coordinator derives it from the run seed)
 *
 * Design:
 *   - Never touches the RPC (same separation principle as agents). All needed market state
 *     is passed in via the FlowContext.
 *   - The Rng is created once at startup and consumed deterministically as each round arrives.
 *     Same seed -> same flow (the fixed market that strategy-evolve's multi-seed evaluation relies on).
 *   - Generation order follows the protocols array passed by the coordinator (= enabledAdapters order).
 */
import { createInterface } from "node:readline";
import { Rng } from "@eris/sdk/rng.js";
import { buildFlowOrders, type FlowContextWire } from "./logic.js";
import { safeStringify } from "@eris/sdk/logger.js";

const flowSeed = Number(process.env.ERIS_FLOW_SEED ?? "1");
if (!Number.isFinite(flowSeed)) {
  process.stderr.write(
    `invalid ERIS_FLOW_SEED: ${process.env.ERIS_FLOW_SEED}\n`,
  );
  process.exit(1);
}

const rng = new Rng(flowSeed);
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const ctx = JSON.parse(line) as FlowContextWire;
    const orders = buildFlowOrders(rng, ctx);
    process.stdout.write(`${safeStringify(orders)}\n`);
  } catch (error) {
    process.stderr.write(
      `flow bot error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    // Even on parse failure, return just empty orders and continue so the RNG stream isn't disturbed.
    process.stdout.write("[]\n");
  }
});
