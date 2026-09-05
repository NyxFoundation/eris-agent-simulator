// Measuring the owner guards on the environment's own contracts (issue #40 T0).
//
// Opening arbitrary bytecode and arbitrary transactions to agents changes what an unguarded setter
// means. Until now, "anyone can call `MockAggregator.setAnswer`" was a fact with no consequence:
// the only senders were the environment's own wallets and the flow bots, and neither had a reason
// to. With participants sending whatever they like, an unguarded price setter is not a market to
// trade against — it is a switch that decides every borrower's liquidation, and using it would be
// indistinguishable from the environment's own oracle write in `blocks.csv`.
//
// So the guards are **measured, not asserted.** Each privileged write is simulated with `eth_call`
// from an address that holds no role. `eth_call` executes without changing state, so a probe costs
// nothing and cannot be mistaken for an attack; a call that *succeeds* is a missing guard, and a
// call that reverts is the guard doing its job. Reading the source instead would have missed this
// entirely for the vendored contracts, whose source is not in this repository.
//
// Two things this deliberately does not do:
//   - it does not test the *deployer's* key exposure. A run whose privileged key is a well-known
//     default mnemonic account is compromised no matter how well the contracts are gated, and that
//     is an operational finding rather than a contract one (see docs/threat-model-agent-markets.md).
//   - it does not probe cheatcode RPCs. Those are the gateway's problem (`RPC_METHOD_DENY`) and are
//     already refused there.
import {
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { RunLogger } from "../logger.js";

// An address with no role in the run: not a wallet the environment derives, not a participant, not
// a venue. Deterministic so the probe is reproducible, and obviously nobody's.
export const GUARD_PROBE_ADDRESS =
  "0x00000000000000000000000000000000feedbeef" as Address;

export type GuardProbe = {
  // What the write is, in the terms a reader of the audit would use.
  label: string;
  address: Address;
  data: Hex;
  // Present only when the guard is expected to be absent by design, with the reason. Everything
  // else is a finding.
  permissionlessByDesign?: string;
};

export type GuardFinding = {
  label: string;
  address: Address;
  // "guarded" = the call reverted from an unprivileged sender (what we want).
  // "unprotected" = it succeeded, so anyone can perform this write.
  // "unreachable" = the probe itself failed for a reason that is not a revert (no code, RPC error),
  //                 which is not evidence either way and must not be reported as a pass.
  status: "guarded" | "unprotected" | "unreachable";
  detail?: string;
};

const priceFeedAbi = parseAbi([
  "function setPrice(int256 answer)",
  "function setPriceFor(address token, int256 answer)",
]);
const aggregatorAbi = parseAbi(["function setAnswer(int256 answer)"]);
const gmxProviderAbi = parseAbi([
  "function setPrice(address token, uint256 price)",
]);
const lstVaultAbi = parseAbi([
  "function setRewardRate(uint256 ratePerBlockRay)",
  "function slash(uint256 bps) returns (uint256)",
  "function setOperator(address account, bool allowed)",
]);
const registryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "entries",
        type: "tuple[]",
        components: [
          { name: "market", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "creator", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "oracle", type: "address" },
          { name: "codehash", type: "bytes32" },
          { name: "verified", type: "bool" },
          { name: "registeredAtBlock", type: "uint64" },
          { name: "extra", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// The privileged writes worth probing, for whatever this run actually deployed.
export function guardProbesFor(opts: {
  priceFeed?: Address;
  marketRegistry?: Address;
  aaveAggregators?: Record<string, Address>;
  lstVault?: Address;
  gmxOracleProvider?: Address;
}): GuardProbe[] {
  const probes: GuardProbe[] = [];
  if (opts.priceFeed) {
    probes.push({
      label: "PriceFeed.setPrice",
      address: opts.priceFeed,
      data: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "setPrice",
        args: [1n],
      }),
    });
  }
  if (opts.marketRegistry) {
    probes.push({
      label: "MarketRegistry.register",
      address: opts.marketRegistry,
      // An empty batch: the point is whether the *caller* is refused, not whether the argument is
      // accepted. A non-empty batch would also be refused for being a duplicate, which would read
      // as a guard that is not there.
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "register",
        args: [[]],
      }),
    });
  }
  for (const [token, aggregator] of Object.entries(
    opts.aaveAggregators ?? {},
  )) {
    probes.push({
      label: `AaveAggregator.setAnswer (${token})`,
      address: aggregator,
      data: encodeFunctionData({
        abi: aggregatorAbi,
        functionName: "setAnswer",
        args: [1n],
      }),
    });
  }
  if (opts.lstVault) {
    probes.push(
      {
        label: "MockLSTVault.setRewardRate",
        address: opts.lstVault,
        data: encodeFunctionData({
          abi: lstVaultAbi,
          functionName: "setRewardRate",
          args: [0n],
        }),
      },
      {
        label: "MockLSTVault.slash",
        address: opts.lstVault,
        data: encodeFunctionData({
          abi: lstVaultAbi,
          functionName: "slash",
          args: [1n],
        }),
      },
      {
        label: "MockLSTVault.setOperator",
        address: opts.lstVault,
        data: encodeFunctionData({
          abi: lstVaultAbi,
          functionName: "setOperator",
          args: [GUARD_PROBE_ADDRESS, true],
        }),
      },
    );
  }
  if (opts.gmxOracleProvider) {
    probes.push({
      label: "MockOracleProvider.setPrice",
      address: opts.gmxOracleProvider,
      data: encodeFunctionData({
        abi: gmxProviderAbi,
        functionName: "setPrice",
        args: [GUARD_PROBE_ADDRESS, 1n],
      }),
    });
  }
  return probes;
}

export async function auditOwnerGuards(
  publicClient: PublicClient,
  probes: GuardProbe[],
): Promise<GuardFinding[]> {
  const findings: GuardFinding[] = [];
  for (const probe of probes) {
    try {
      const code = await publicClient.getCode({ address: probe.address });
      if (!code || code === "0x") {
        findings.push({
          label: probe.label,
          address: probe.address,
          status: "unreachable",
          detail: "no code at the address",
        });
        continue;
      }
    } catch (error) {
      findings.push({
        label: probe.label,
        address: probe.address,
        status: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      await publicClient.call({
        account: GUARD_PROBE_ADDRESS,
        to: probe.address,
        data: probe.data,
      });
      // It did not revert. Anybody can do this.
      findings.push({
        label: probe.label,
        address: probe.address,
        status: "unprotected",
        ...(probe.permissionlessByDesign
          ? { detail: probe.permissionlessByDesign }
          : {}),
      });
    } catch (error) {
      findings.push({
        label: probe.label,
        address: probe.address,
        status: "guarded",
        detail: shortRevert(error),
      });
    }
  }
  return findings;
}

function shortRevert(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n").find((l) => /revert|reason|not owner|not operator/i.test(l));
  return (line ?? message.split("\n")[0] ?? "").trim().slice(0, 160);
}

// The findings that are actually problems: an unprotected write with no stated reason to be one.
export function unprotectedFindings(
  findings: GuardFinding[],
  probes: GuardProbe[],
): GuardFinding[] {
  const excused = new Set(
    probes
      .filter((p) => p.permissionlessByDesign)
      .map((p) => `${p.label}|${p.address.toLowerCase()}`),
  );
  return findings.filter(
    (f) =>
      f.status === "unprotected" &&
      !excused.has(`${f.label}|${f.address.toLowerCase()}`),
  );
}

export function guardFailureMessage(findings: GuardFinding[]): string {
  const lines = findings.map((f) => `  - ${f.label} @ ${f.address}`);
  return (
    "[owner-guards] the following privileged writes can be performed by anyone:\n" +
    `${lines.join("\n")}\n` +
    "Refusing to start a run in which agents can send arbitrary transactions (issue #40 T0): an " +
    "unguarded price setter is not a market to trade against, it is a switch that decides every " +
    "borrower's liquidation, and in blocks.csv it is indistinguishable from the environment's own " +
    "oracle write. Fix the contract, or run with `agentMarkets.enabled: false`, which restores the " +
    "condition under which this was harmless: no participant sends transactions the environment " +
    "did not build.\n" +
    "See docs/threat-model-agent-markets.md."
  );
}

export function logGuardAudit(
  logger: RunLogger,
  findings: GuardFinding[],
): void {
  logger.event({
    type: "owner_guard_audit",
    probe: GUARD_PROBE_ADDRESS,
    findings,
    // Counted as well as listed: an audit that found nothing to probe reads exactly like an audit
    // that found everything guarded, and they are not the same result.
    probed: findings.length,
    guarded: findings.filter((f) => f.status === "guarded").length,
    unprotected: findings.filter((f) => f.status === "unprotected").length,
    unreachable: findings.filter((f) => f.status === "unreachable").length,
  });
}
