import { Command } from "commander";
import { startAnvil, stopAnvil, anvilManagedHere } from "./anvil.js";
import { MANAGE_ANVIL } from "./config.js";
import { reset, flush, getRegistry } from "./registry.js";
import { deployTokens } from "./tokens.js";
import { info, ok } from "./util.js";

// Per-protocol deploy functions (added incrementally)
import { deployUniswapV3 } from "./protocols/uniswap-v3.js";
import { deployBalancerV2 } from "./protocols/balancer-v2.js";
import { deployAaveV3 } from "./protocols/aave-v3.js";
import { deployCurve } from "./protocols/curve.js";
import { deployGmxV2 } from "./protocols/gmx-v2.js";

type ProtocolName = "uniswap" | "balancer" | "aave" | "gmx" | "curve";

// gmx takes several minutes via hardhat-deploy, so put it last in ALL
const ALL: ProtocolName[] = ["uniswap", "balancer", "aave", "curve", "gmx"];

const DEPLOYERS: Record<
  ProtocolName,
  (opts: { seed: boolean }) => Promise<void>
> = {
  uniswap: deployUniswapV3,
  balancer: deployBalancerV2,
  aave: deployAaveV3,
  curve: deployCurve,
  gmx: deployGmxV2,
};

async function main() {
  const program = new Command();
  program
    .option("--only <list>", "narrow deploy targets (e.g. uniswap,balancer)")
    .option("--no-seed", "skip pool creation and liquidity seeding")
    .option("--keep-fresh", "reset deployments.json before starting")
    .option("--exit", "stop anvil and exit the process when done (for CI)")
    .parse(process.argv);
  const opts = program.opts();

  const targets: ProtocolName[] = opts.only
    ? (String(opts.only)
        .split(",")
        .map((s) => s.trim()) as ProtocolName[])
    : ALL;
  const seed: boolean = opts.seed !== false;

  if (opts.keepFresh) reset();

  if (MANAGE_ANVIL) await startAnvil();

  try {
    await deployTokens();

    for (const name of targets) {
      info(`protocol: ${name}`);
      await DEPLOYERS[name]({ seed });
    }

    flush();
    info("done");
    const reg = getRegistry();
    ok(
      "deployments.json written",
      `protocols: ${Object.keys(reg.protocols).join(", ")}`,
    );
  } catch (e) {
    console.error(e);
    if (MANAGE_ANVIL && anvilManagedHere()) stopAnvil();
    process.exit(1);
  }

  if (opts.exit) {
    if (MANAGE_ANVIL && anvilManagedHere()) stopAnvil();
    process.exit(0);
  }

  // By default keep anvil running (so the deployed chain stays usable)
  if (MANAGE_ANVIL && anvilManagedHere()) {
    console.log("\nanvil is still running. Press Ctrl-C to stop.");
    await new Promise<never>(() => {}); // keep the process alive
  }
}

main().catch((e) => {
  console.error(e);
  stopAnvil();
  process.exit(1);
});
