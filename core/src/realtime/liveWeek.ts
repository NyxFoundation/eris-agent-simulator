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
import { formatEther, formatUnits, type Address } from "viem";
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

  // Rules §2.5: every agent revises through the operator's proxy, on the participant's own
  // credential. Without the URL the agents have no model at all (an isolated container has no
  // other way out), and the week would run sixty epochs of unrevised strategies and say nothing.
  if (!opts.env.ERIS_INFERENCE_BASE_URL)
    reasons.push(
      "no inference proxy for the agents: set ERIS_INFERENCE_BASE_URL (and ERIS_INFERENCE_SECRET) " +
        "to the operator's proxy started with --keys (infra/inference-proxy/README.md)",
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

/** What the chain check reads: native ETH, and one ERC-20 balance. Both at latest. */
export type PublicAccountReader = {
  eth: (address: Address) => Promise<bigint>;
  erc20: (token: Address, address: Address) => Promise<bigint>;
};

/**
 * The refusal for anvil's public test accounts holding anything on the chain the live week runs on,
 * or undefined when every one of them is empty. ETH and every registry token: the backtest chain runs
 * at base fee 0, so an account with tokens and no ETH can still be emptied by a zero-priced transfer.
 * What this does not read is venue positions (LP shares, Aave supply, Troves) -- a dump whose deployer
 * holds those is the default-mnemonic dump, which stateDumpRefusal refuses by its manifest.
 */
export async function publicAccountRefusal(
  read: PublicAccountReader,
  tokens: ReadonlyArray<{ symbol: string; address: Address; decimals: number }>,
): Promise<string | undefined> {
  const funded: string[] = [];
  for (const address of publicTestAddresses()) {
    const held: string[] = [];
    const wei = await read.eth(address as Address);
    if (wei > 0n) held.push(`${formatEther(wei)} ETH`);
    for (const token of tokens) {
      const units = await read.erc20(token.address, address as Address);
      if (units > 0n) held.push(`${formatUnits(units, token.decimals)} ${token.symbol}`);
    }
    if (held.length > 0) funded.push(`${address} (${held.join(", ")})`);
  }
  if (funded.length === 0) return undefined;
  return (
    `anvil's public test accounts hold funds, and their keys are in anvil's banner: ` +
    `${funded.join("; ")}. Any participant can sign a transfer from them to their own wallet. ` +
    "Start the chain with --accounts 0 and load a state dump deployed from the secret mnemonic"
  );
}

/**
 * The refusal for a state dump that carries anvil's public test accounts, from its manifest
 * (genStateDump.ts measures them), or undefined for one deployed from a secret mnemonic. A manifest
 * without the field predates the measurement and is refused too: the week should not run on a dump
 * nobody checked.
 */
export function stateDumpRefusal(manifest: {
  publicTestAccounts?: ReadonlyArray<{ address: string; balanceWei: string; nonce: number }>;
}): string | undefined {
  const regenerate =
    'Deploy from the secret mnemonic (cd deployer && MNEMONIC="$(cat <secret>)" npm run deploy -- ' +
    "--keep-fresh), then npm run gen:local-constants and npm run gen:state-dump";
  if (manifest.publicTestAccounts === undefined)
    return (
      "the state dump's manifest does not say whether it carries anvil's public test accounts " +
      `(written before gen:state-dump measured them). ${regenerate}`
    );
  if (manifest.publicTestAccounts.length === 0) return undefined;
  const signed = manifest.publicTestAccounts.filter((a) => a.nonce > 0);
  return (
    `the state dump carries ${manifest.publicTestAccounts.length} of anvil's public test accounts` +
    (signed.length > 0
      ? `, and ${signed.map((a) => a.address).join(", ")} signed on the chain it came from ` +
        "(it was deployed from the default mnemonic, so the venues' admin keys are public too)"
      : "") +
    `: ${manifest.publicTestAccounts.map((a) => `${a.address} (${formatEther(BigInt(a.balanceWei))} ETH)`).join(", ")}. ` +
    regenerate
  );
}

/**
 * What GET /healthz on the inference proxy has to say for the live week: the proxy forwards the
 * participants' own credentials (`--keys`), not the operator's. A proxy on the operator's keys would
 * revise every agent on one key the operator pays for, the opposite of rules §2.5, and nothing else
 * in the run would show it. Pure: the caller fetches, this reads.
 */
export function inferenceProxyRefusal(health: unknown): string | undefined {
  const h = health as { ok?: unknown; credentials?: unknown } | null;
  if (!h || typeof h !== "object" || h.ok !== true)
    return "the inference proxy at ERIS_INFERENCE_BASE_URL did not answer GET /healthz with {ok: true}";
  if (h.credentials !== "participant")
    return (
      `the inference proxy forwards the ${String(h.credentials ?? "operator")}'s credentials: start it ` +
      "with --keys <keys.yaml> so each agent revises on the credential its participant submitted (rules §2.5)"
    );
  return undefined;
}

/**
 * Fetch the proxy's /healthz and read it with inferenceProxyRefusal. The URL the agents use may be a
 * container-network name this host cannot resolve; ERIS_INFERENCE_PROBE_URL names the same proxy as
 * this host reaches it.
 */
export async function probeInferenceProxy(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const base = env.ERIS_INFERENCE_PROBE_URL ?? env.ERIS_INFERENCE_BASE_URL;
  if (!base) return undefined; // liveWeekRefusals already names the missing URL
  let body: unknown;
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, "")}/healthz`);
    body = await res.json();
  } catch (error) {
    return (
      `the inference proxy at ${base} is not reachable from this host (${
        error instanceof Error ? error.message : String(error)
      }); set ERIS_INFERENCE_PROBE_URL if the agents' URL is a container-network name`
    );
  }
  return inferenceProxyRefusal(body);
}
