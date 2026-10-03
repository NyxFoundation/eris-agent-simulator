// What has to hold before the environment runs participants' submitted code on a scored chain.
//
// Rules §3.1 names what participants may attack (the operator's protocols and the other units'
// agents) and terms Art. 14(3) / rules §8 forbid everything else: the oracle writes, the venues'
// admin roles, the node's cheatcodes, the operator's hosts. A published list only says so. What
// makes the rest unreachable rather than merely forbidden is two things this repository already has:
//
//   - the environment's keys (roleKeyGuard.ts). A chain whose admin / keeper / deployer keys are
//     public hands the fair price, GMX execution and Aave's POOL_ADMIN to whoever reads anvil's
//     banner. The guard refused that only for a chain it recognised as open -- a registrations file
//     or an `external` roster entry -- and the live week has neither: every agent is a submitted
//     bundle the operator launches. An official matrix on a dump deployed from the default mnemonic
//     passed without a word.
//   - the agents' network (agentView.ts, infra/docker-agent/ISOLATION.md). Without
//     ERIS_AGENT_ISOLATE=1 + ERIS_AGENT_INTERNAL=1 a container shares the host's network and reaches
//     anvil directly, past the gateway that refuses `anvil_*` / `evm_*`. That was a banner, which is
//     right for local runs and the reference field and wrong for the week that is scored.
//   - anvil's public test accounts. Their keys are printed in anvil's banner and the gateway relays
//     eth_sendRawTransaction from any sender it can verify a signature for, so whatever those ten
//     addresses hold, every participant holds: one transfer to the agent's own wallet adds it to V_K,
//     and the epoch's revert puts it back for the next one. The backtest anvil used to create them
//     with 1,000,000 ETH each (`--accounts 10 --balance 1000000`); it now creates none, and a dump
//     deployed from the default mnemonic carries them in the state itself. No key here signs for
//     them, so the check is on the chain: their balances, read before any agent starts.
//
// So in the live week all three become refusals. The live week is recognised the way the backtest runner
// already recognises it for the scenario key (ADR 0027): an ordered plan realised under a key file.
// A rehearsal of the plan runs with --scenario-key public, which is not the live week.
import { formatEther, type Address } from "viem";
import type { AgentSpec } from "@eris/sdk/types.js";
import { agentSandboxWarning } from "./agentView.js";
import {
  checkRoleKeys,
  publicTestAddresses,
  type RoleKeys,
  type RoleKeyUse,
} from "./roleKeyGuard.js";

/** The matrix runner's override that marks one epoch as the live week's (honoured from nowhere else). */
export const LIVE_WEEK_OVERRIDE = "ERIS_LIVE_WEEK";

/** Thrown instead of a plain Error so the matrix runner stops the week rather than skipping an epoch. */
export class LiveWeekRefusal extends Error {
  constructor(reasons: string[]) {
    super(
      "the live week cannot start:\n" +
        reasons.map((r) => `  - ${r}`).join("\n") +
        "\nA rehearsal of the plan runs with --scenario-key public, which is not the live week (ADR 0027).",
    );
    this.name = "LiveWeekRefusal";
  }
}

export function isLiveWeekRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "LiveWeekRefusal";
}

/** Every reason this run cannot be the live week; empty when it can. */
export function liveWeekRefusals(opts: {
  keys: RoleKeys;
  use: RoleKeyUse;
  venueAdmin?: Address;
  sandbox: "process" | "docker";
  agents: ReadonlyArray<AgentSpec>;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): string[] {
  const reasons: string[] = [];

  // No ERIS_ALLOW_PUBLIC_ROLE_KEYS here: that switch is for a private rehearsal, and a rehearsal is
  // not the live week.
  const keys = checkRoleKeys({
    keys: opts.keys,
    use: opts.use,
    venueAdmin: opts.venueAdmin,
    agents: opts.agents,
    liveWeek: true,
    allowPublic: false,
  });
  if (keys.kind !== "ok")
    reasons.push(
      `public keys: ${keys.exposed.join("; ")}. Set ADMIN_PRIVATE_KEY / KEEPER_PRIVATE_KEY / ` +
        "SETUP_PRIVATE_KEY to keys made for the week and DEPLOYER_PRIVATE_KEY to index 0 of the " +
        "secret mnemonic the state dump was deployed with",
    );

  if (opts.sandbox !== "docker")
    reasons.push(
      `run.agentSandbox is ${opts.sandbox}: submitted agents would run as plain processes on this ` +
        "host, outside the rules §2.3 caps and the network isolation (infra/docker-agent/run-agent.sh)",
    );

  const custom = opts.agents
    .filter((a) => a.external !== true && a.command !== undefined)
    .map((a) => a.id);
  if (custom.length > 0)
    reasons.push(
      `roster entries with command/args start outside the container: ${custom.join(", ")}`,
    );

  if (opts.sandbox === "docker") {
    const launched = opts.agents.filter(
      (a) => a.external !== true && a.address === undefined && a.command === undefined,
    );
    const warning = agentSandboxWarning(
      launched.map((a) => ({ id: a.id, env: { ...opts.env, ...(a.env ?? {}) } })),
      { platform: opts.platform },
    );
    if (warning?.sharedNetwork.length)
      reasons.push(
        "agents on a shared network reach this host's services, anvil included, past the RPC " +
          `gateway: ${warning.sharedNetwork.map((a) => a.id).join(", ")}. Set ERIS_AGENT_ISOLATE=1`,
      );
    if (warning?.openEgress.length)
      reasons.push(
        `agents with a route out: ${warning.openEgress.join(", ")}. Set ERIS_AGENT_INTERNAL=1 ` +
          "(inference goes through the operator's proxy on the same network)",
      );
    if (warning?.bindMount.length)
      reasons.push(
        `bind-mount mode mounts the repository into the container: ${warning.bindMount.join(", ")}. ` +
          "Unset ERIS_AGENT_BINDMOUNT and run the per-agent images",
      );
  }
  return reasons;
}

/**
 * The refusal for anvil's public test accounts holding ETH on the chain the live week runs on, or
 * undefined when every one of them is empty. `balanceOf` reads the chain (eth_getBalance at latest).
 */
export async function publicAccountRefusal(
  balanceOf: (address: Address) => Promise<bigint>,
): Promise<string | undefined> {
  const funded: string[] = [];
  for (const address of publicTestAddresses()) {
    const wei = await balanceOf(address as Address);
    if (wei > 0n) funded.push(`${address} (${formatEther(wei)} ETH)`);
  }
  if (funded.length === 0) return undefined;
  return (
    `anvil's public test accounts hold ETH, and their keys are in anvil's banner: ` +
    `${funded.join(", ")}. Any participant can sign a transfer from them to their own wallet. ` +
    "Start the chain with --accounts 0 and load a state dump deployed from the secret mnemonic"
  );
}

