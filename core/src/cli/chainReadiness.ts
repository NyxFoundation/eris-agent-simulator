// Can a coordinator still start on this chain? (read-only)
//
// Three startup checks refuse a chain that predates a change to a venue, and all three are things
// an operator has to know *before* taking the environment down: the answer decides whether a live
// migration is possible at all or whether the chain has to be redeployed, and a redeploy resets a
// practice period's standings.
//
// This reads. It sends nothing, signs nothing, and needs no key. It calls the same functions the
// coordinator calls at startup (aaveReserveGuard / liquity), so a PASS here means that check will
// pass there -- not something resembling it.
//
//   ERIS_LOCAL_DEPLOY=1 npx tsx core/src/cli/chainReadiness.ts --rpc http://127.0.0.1:8545
//
// The venue addresses come from the constants overlay, so point it at the same deployment the
// coordinator would use (DEPLOYMENTS_JSON + `npm run gen:local-constants`).
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { anvil } from "viem/chains";
import { AAVE, LIQUITY, GMX_MARKETS } from "@eris/sdk/constants.js";
import {
  environmentReserveAssets,
  readAaveReserves,
  strayAaveReserves,
  type AaveReserveState,
} from "../realtime/aaveReserveGuard.js";
import { MIN_ENV_LQTY_STAKE_WEI, lqtyStakeProblem } from "../realtime/liquity.js";

const lqtyStakingAbi = [
  {
    type: "function",
    name: "totalLQTYStaked",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// viem's contract errors are several paragraphs. An operator wants the first line, plus the one
// cause that is actually likely here: the constants overlay naming a different deployment than the
// node holds, which is the same mismatch the coordinator's deployment_check exists for.
function readFailure(e: unknown): string {
  const first =
    e instanceof Error ? e.message.split("\n")[0] : String(e);
  const noCode = /returned no data|no data \("0x"\)/.test(
    e instanceof Error ? e.message : String(e),
  );
  return noCode
    ? `${first} -- the address in this constants overlay holds no code on that node. ` +
        "Point DEPLOYMENTS_JSON at the node's own deployments.json and re-run " +
        "`npm run gen:local-constants`."
    : first;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The repo's erc20 ABI carries no `symbol`, and a vendor test token may not answer it either, so
// the label is best-effort: it names the reserve in the output and nothing reads it.
const symbolAbi = [
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const;

async function symbolOf(
  client: ReturnType<typeof createPublicClient>,
  token: Address,
): Promise<string> {
  try {
    return (await client.readContract({
      address: token,
      abi: symbolAbi,
      functionName: "symbol",
    })) as string;
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  const rpc = arg("rpc", process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545")!;
  const client = createPublicClient({ chain: anvil, transport: http(rpc) });
  let block: bigint;
  try {
    block = await client.getBlockNumber({ cacheTime: 0 });
  } catch (e) {
    // An operator runs this against a box, so the first thing to get right is "I could not reach
    // the node", said in one line rather than as a transport stack trace.
    console.error(
      `cannot reach ${rpc}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    );
    console.error("Pass --rpc, or set ANVIL_RPC_URL.");
    process.exitCode = 2;
    return;
  }
  console.log(`chain ${rpc} at block ${block}\n`);
  let blocking = 0;

  // --- Aave: the vendor test market (issue #190) ----------------------------
  // A frozen reserve passes only when nobody but the treasury holds anything in it. A participant's
  // aToken or debt keeps it a finding, and the operator cannot remove a participant's position --
  // which is the one condition that rules a live migration out rather than merely complicating it.
  console.log("Aave vendor reserves");
  if (!AAVE?.Pool) {
    console.log("  skipped: no Aave in this deployment overlay\n");
  } else {
    let reserves: AaveReserveState[];
    try {
      reserves = await readAaveReserves(client);
    } catch (e) {
      console.log(`  READ FAILED: ${readFailure(e)}\n`);
      process.exitCode = 2;
      return;
    }
    const ours = environmentReserveAssets();
    const theirs = reserves.filter((r) => !ours.has(r.asset.toLowerCase()));
    const stray = strayAaveReserves(reserves, ours);
    console.log(
      `  ${reserves.length} reserves, ${ours.size} the environment owns, ${theirs.length} vendor`,
    );
    for (const r of theirs) {
      const sym = await symbolOf(client, r.asset);
      const held = r.participantSupply > 0n || r.debt > 0n;
      const state = !r.active ? "inactive" : r.frozen ? "frozen" : "ACTIVE";
      console.log(
        `  ${r.asset} ${sym.padEnd(10)} ${state.padEnd(8)}` +
          ` supply(non-treasury)=${r.participantSupply} debt=${r.debt}` +
          (held ? "   <- held by a participant" : ""),
      );
    }
    if (stray.length === 0) {
      console.log("  PASS: the startup check accepts this chain");
    } else {
      blocking++;
      const held = stray.filter((r) => r.participantSupply > 0n || r.debt > 0n);
      console.log(`  REFUSED: ${stray.length} reserve(s) the check calls stray`);
      if (held.length > 0)
        console.log(
          `  ${held.length} of them hold a participant's position. ` +
            "Closing the market does not remove those, and the operator cannot: " +
            "a live migration is not available while they are there.",
        );
      else
        console.log(
          "  None of them hold a participant's position, so `cd deployer && " +
            "RPC_URL=<node> npm run close:aave-vendor` clears this check.",
        );
    }
    console.log();
  }

  // --- Liquity: the environment's LQTY stake (issue #240) -------------------
  console.log("Liquity environment LQTY stake");
  if (!LIQUITY?.lqtyStaking) {
    console.log("  skipped: no Liquity in this deployment overlay\n");
  } else {
    try {
      const staked = (await client.readContract({
        address: LIQUITY.lqtyStaking,
        abi: lqtyStakingAbi,
        functionName: "totalLQTYStaked",
      })) as bigint;
      const problem = lqtyStakeProblem(staked);
      console.log(
        `  totalLQTYStaked = ${formatUnits(staked, 18)} LQTY ` +
          `(the check wants ${formatUnits(MIN_ENV_LQTY_STAKE_WEI, 18)})`,
      );
      if (!problem) console.log("  PASS");
      else {
        blocking++;
        console.log("  REFUSED: the deployment predates the environment's stake");
        console.log(
          "  LQTYToken refuses the multisig as a staking sender for a year, and on a deployment " +
            "that predates this the multisig is the deployer, so the stake cannot be placed from " +
            "the account that holds the LQTY.",
        );
      }
    } catch (e) {
      console.log(`  READ FAILED: ${readFailure(e)}`);
      process.exitCode = 2;
      return;
    }
    console.log();
  }

  // --- GMX: whether the fee configuration is the competition's (issue #233) --
  // Not a startup check: a chain with no position fee starts and runs. It is here because it is the
  // other half of "is this chain the competition's economy", and it is the half a live migration
  // can fix with ordinary transactions from the config keeper.
  console.log("GMX position fee (not a startup check)");
  const markets = Object.values(GMX_MARKETS ?? {});
  if (markets.length === 0) {
    console.log("  skipped: no GMX markets in this deployment overlay\n");
  } else {
    console.log(
      `  ${markets.length} market(s) configured. The fee, leverage, impact, borrowing and funding ` +
        "keys are all in\n  GMX Config's allowedBaseKeys, so the config keeper can write the " +
        "competition's values without a redeploy.\n  Read them per market with `Reader` or " +
        "`DataStore.getUint` to confirm which values this chain holds.",
    );
    console.log();
  }

  console.log(
    blocking === 0
      ? "A coordinator can start on this chain."
      : `A coordinator cannot start on this chain: ${blocking} check(s) refuse it.`,
  );
  if (blocking > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
