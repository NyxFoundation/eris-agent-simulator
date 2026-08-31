// Is the deployment this run names actually on the chain it is pointed at?
//
// There are two independent axes to a run's target, and they are set in different places:
//
//   which chain   ANVIL_RPC_URL / CHAIN_ID in .env.local, and run.chainMode
//   which deployment   sdk/src/constants.local.ts, generated from a deployments.json
//
// So moving between a local dev node and a devnet means changing both, and changing one is an easy
// mistake to make. Without this check the result is a stack trace naming a bare address:
//
//   Cannot decode zero data ("0x")
//     to: 0x610178dA211FEF7D417bC0e6FeD39F05609AD788
//
// which is what a call to an address holding no code looks like, and says nothing about the actual
// problem. The addresses are known up front and `eth_getCode` is one round trip each, so the run can
// simply look before it starts.
//
// It runs in both chain modes. Pointing a local run at the wrong anvil is exactly as easy as
// pointing an external one at the wrong devnet.
import type { Address, PublicClient } from "viem";
import {
  AAVE,
  BALANCER,
  CURVE,
  GMX,
  LIQUITY,
  LST,
  MULTICALL3,
  UNISWAP,
} from "@eris/sdk/constants.js";
import { baseTokens, marketsFor, stableTokens } from "@eris/sdk/markets.js";
import type { ProtocolId } from "@eris/sdk/types.js";

export type DeploymentTarget = { what: string; address: Address };

// One or two load-bearing contracts per venue, plus the shared pieces every run reads. Not the whole
// deployment: the question is "is this the right chain", and a venue whose router is present but
// whose pool is not is a broken deploy rather than a wrong chain -- which the no-arbitrage startup
// check already covers.
export function deploymentTargets(
  enabledIds: ProtocolId[],
): DeploymentTarget[] {
  const targets: DeploymentTarget[] = [
    { what: "Multicall3", address: MULTICALL3 },
  ];
  for (const t of [...baseTokens(), ...stableTokens()])
    targets.push({ what: `token ${t.symbol}`, address: t.address });

  if (enabledIds.includes("uniswap")) {
    targets.push({ what: "uniswap SwapRouter", address: UNISWAP.swapRouter });
    const pool = marketsFor("uniswap").find((m) => m.base === "WETH")?.uniswap
      ?.pool;
    if (pool) targets.push({ what: "uniswap WETH pool", address: pool });
  }
  if (enabledIds.includes("balancer"))
    targets.push({ what: "balancer Vault", address: BALANCER.vault });
  if (enabledIds.includes("curve"))
    targets.push({ what: "curve pool", address: CURVE.pool });
  if (enabledIds.includes("gmx")) {
    targets.push({ what: "gmx DataStore", address: GMX.DataStore });
    targets.push({ what: "gmx ExchangeRouter", address: GMX.ExchangeRouter });
  }
  if (enabledIds.includes("aave")) {
    targets.push({ what: "aave Pool", address: AAVE.Pool });
    targets.push({ what: "aave AclManager", address: AAVE.AclManager });
  }
  if (enabledIds.includes("lst") && LST) {
    targets.push({ what: "lst vault", address: LST.vault });
    targets.push({ what: "lst pool", address: LST.pool });
  }
  if (enabledIds.includes("liquity") && LIQUITY) {
    targets.push({
      what: "liquity TroveManager",
      address: LIQUITY.troveManager,
    });
    targets.push({
      what: "liquity BorrowerOperations",
      address: LIQUITY.borrowerOperations,
    });
  }
  return targets;
}

export type DeploymentCheck = {
  chainId: number;
  checked: number;
  missing: DeploymentTarget[];
};

export async function checkDeployment(opts: {
  publicClient: PublicClient;
  enabledIds: ProtocolId[];
}): Promise<DeploymentCheck> {
  const targets = deploymentTargets(opts.enabledIds);
  const chainId = await opts.publicClient.getChainId();
  const codes = await Promise.all(
    targets.map((t) =>
      opts.publicClient
        .getCode({ address: t.address })
        .catch(() => undefined as `0x${string}` | undefined),
    ),
  );
  return {
    chainId,
    checked: targets.length,
    missing: targets.filter((_, i) => !codes[i] || codes[i] === "0x"),
  };
}

export function deploymentMismatchMessage(
  check: DeploymentCheck,
  rpcUrl: string,
): string {
  const named = check.missing
    .slice(0, 6)
    .map((m) => `${m.what} (${m.address})`)
    .join(", ");
  const more =
    check.missing.length > 6 ? ` and ${check.missing.length - 6} more` : "";
  return (
    `the deployment this run names is not on ${rpcUrl} (chainId ${check.chainId}): ` +
    `${check.missing.length} of ${check.checked} contracts hold no code — ${named}${more}.\n` +
    "  Two things pick a target and they are set in different places: the chain comes from " +
    "ANVIL_RPC_URL / CHAIN_ID, and the addresses come from sdk/src/constants.local.ts.\n" +
    "  Point them at the same deployment:\n" +
    "    DEPLOYMENTS_JSON=<that chain's deployments.json> npm run gen:local-constants\n" +
    "  (or drop run.localDeploy if this is meant to be a fork of a live chain)"
  );
}
