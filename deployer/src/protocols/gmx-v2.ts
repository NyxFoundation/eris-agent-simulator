import { spawnSync } from "node:child_process";
import {
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Abi, type Address } from "viem";
import { publicClient } from "../clients.js";
import { ROOT, ok, info, assert, loadForgeArtifact } from "../util.js";
import { RPC_URL } from "../config.js";
import { setProtocol, getRegistry } from "../registry.js";
import { seedGmLiquidity, type GmDepositCore } from "./gmx-deposit.js";

const GMX_DIR = resolve(ROOT, "vendor", "gmx-src");
const DEPLOYMENTS = resolve(GMX_DIR, "deployments", "localhost");

function dep(name: string): { address: Address; abi: Abi } {
  const j = JSON.parse(
    readFileSync(resolve(DEPLOYMENTS, `${name}.json`), "utf8"),
  );
  return { address: j.address as Address, abi: j.abi as Abi };
}

// Main contracts to import into the registry
const CORE = [
  "DataStore",
  "RoleStore",
  "EventEmitter",
  "Oracle",
  "Router",
  "ExchangeRouter",
  "Reader",
  "OrderHandler",
  "DepositHandler",
  "WithdrawalHandler",
  "LiquidationHandler",
  "MarketFactory",
  "OrderVault",
  "DepositVault",
  "WithdrawalVault",
  "Config",
];
const GMX_TOKENS = ["WETH", "GMX", "USDC", "WBTC", "USDT"];

// Tokens shared between GMX and the shared mocks (excludes GMX's own GMX/ESGMX/SOL).
// WETH is WETH9 (wrappedNative), the rest are MockERC20.
const SHARED_TOKEN_KEYS = ["WETH", "USDC", "USDT", "WBTC"] as const;

/**
 * **Pre-place** hardhat-deploy's deployments/localhost/<symbol>.json so that deployTestTokens.ts's
 * getOrNull reuse path (reuse an existing token instead of deploying a new one) makes GMX adopt the
 * shared mock tokens.
 * Call this right after rmSync and before running hardhat deploy.
 */
function seedSharedTokenArtifacts() {
  const reg = getRegistry();
  mkdirSync(DEPLOYMENTS, { recursive: true });
  // hardhat-deploy requires a .chainId in the network folder
  writeFileSync(resolve(DEPLOYMENTS, ".chainId"), "31337");

  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");

  const shared: string[] = [];
  for (const key of SHARED_TOKEN_KEYS) {
    const raw = reg.tokens[key];
    if (!raw) continue; // skip if the shared token is not deployed (e.g. --only gmx)
    // EIP-55 checksum required: gmx.getTokens() is memoized, and a reused token's address gets
    // baked into config without passing through the checksum loop. Left lowercase, the marketKey
    // string mismatches the checksummed address returned by Reader.getMarkets, and
    // deployAndConfigureMarkets fails.
    const addr = getAddress(raw);
    const abi = key === "WETH" ? weth9.abi : erc20.abi;
    // A hardhat-deploy Deployment resolves via getOrNull with just {address, abi} at minimum.
    // Do not include bytecode (avoids bytecode-match verification).
    writeFileSync(
      resolve(DEPLOYMENTS, `${key}.json`),
      JSON.stringify({ address: addr, abi }, null, 2),
    );
    shared.push(`${key}=${addr}`);
  }
  if (shared.length) ok("GMX shared token pre-placement", shared.join(", "));
}

export async function deployGmxV2({ seed }: { seed: boolean }) {
  info(
    "Deploying the full GMX V2 system via hardhat-deploy (heavy: takes several minutes)",
  );

  rmSync(DEPLOYMENTS, { recursive: true, force: true });
  seedSharedTokenArtifacts();

  const res = spawnSync(
    "npx",
    ["hardhat", "deploy", "--network", "localhost"],
    {
      cwd: GMX_DIR,
      env: { ...process.env, SKIP_AUTO_HANDLER_REDEPLOYMENT: "true", RPC_URL },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (res.status !== 0) {
    throw new Error(`gmx hardhat deploy failed (exit ${res.status})`);
  }
  assert(
    existsSync(DEPLOYMENTS),
    "gmx deployments/localhost was not generated",
  );

  const core: Record<string, Address> = {};
  for (const name of CORE) {
    if (existsSync(resolve(DEPLOYMENTS, `${name}.json`)))
      core[name] = dep(name).address;
  }
  const tokens: Record<string, Address> = {};
  for (const t of GMX_TOKENS) {
    if (existsSync(resolve(DEPLOYMENTS, `${t}.json`)))
      tokens[t] = dep(t).address;
  }

  setProtocol("gmxV2", { ...core, tokens });
  ok("GMX V2 deploy", `DataStore=${core.DataStore}`);
  ok("GMX tokens", Object.keys(tokens).join(", "));

  if (seed) {
    const markets = await recordMarkets();
    await seedGmMarket(core, tokens, markets);
  }
}

/**
 * Seed liquidity into each index market's GM pool. With an empty pool, the poc GMX trading agents
 * cannot open positions, so deposit during the deploy seed.
 * ADR 0013: seed the WBTC(BTC/USD) market in addition to WETH(ETH/USD).
 */
async function seedGmMarket(
  core: Record<string, Address>,
  tokens: Record<string, Address>,
  markets: GmMarketRecord[],
) {
  const weth = tokens.WETH;
  const usdc = tokens.USDC;
  const wbtc = tokens.WBTC;
  if (!weth || !usdc) return;

  const depositCore: GmDepositCore = {
    DataStore: core.DataStore,
    Oracle: core.Oracle,
    Router: core.Router,
    ExchangeRouter: core.ExchangeRouter,
    DepositVault: core.DepositVault,
    DepositHandler: core.DepositHandler,
  };

  // WETH/USDC: at $3000/WETH, seed 200 WETH + 600k USDC ($1.2M, consistent with the AMM venue)
  const wethMarket = markets.find(
    (m) =>
      m.longToken.toLowerCase() === weth.toLowerCase() &&
      m.shortToken.toLowerCase() === usdc.toLowerCase(),
  );
  if (!wethMarket) {
    info("GM liquidity: skipping (no WETH/USDC market)");
  } else {
    await seedGmLiquidity(
      depositCore,
      {
        marketToken: wethMarket.marketToken,
        longToken: wethMarket.longToken,
        shortToken: wethMarket.shortToken,
      },
      200n * 10n ** 18n,
      600_000n * 10n ** 6n,
      [
        { token: weth, usd: 3000, decimals: 18 },
        { token: usdc, usd: 1, decimals: 6 },
      ],
    );
  }

  // WBTC/USDC (BTC/USD market, ADR 0013). Search by index=WBTC (long=WBTC, short=USDC).
  // To avoid a silent skip, throw if the WBTC token exists but no market is found.
  if (wbtc) {
    const wbtcMarket = markets.find(
      (m) =>
        m.indexToken.toLowerCase() === wbtc.toLowerCase() &&
        m.longToken.toLowerCase() === wbtc.toLowerCase() &&
        m.shortToken.toLowerCase() === usdc.toLowerCase(),
    );
    if (!wbtcMarket) {
      throw new Error(
        "GM liquidity: WBTC/USDC market not found (no WBTC market in the markets.ts localhost array, or redeploy not performed)",
      );
    }
    // At $60000/WBTC, seed 50 WBTC(decimals:8) + 3M USDC.
    // Price is equivalent to toGmxPrice(60000, 8) (WBTC decimals:8 is explicit; left at 18 it would be off by 10^10 and break).
    await seedGmLiquidity(
      depositCore,
      {
        marketToken: wbtcMarket.marketToken,
        longToken: wbtcMarket.longToken,
        shortToken: wbtcMarket.shortToken,
      },
      50n * 10n ** 8n,
      3_000_000n * 10n ** 6n,
      [
        { token: wbtc, usd: 60000, decimals: 8 },
        { token: usdc, usd: 1, decimals: 6 },
      ],
    );
  }
}

type GmMarketRecord = {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
};

/** Read the deployed markets via Reader.getMarkets, record them in the registry, and return the array */
async function recordMarkets(): Promise<GmMarketRecord[]> {
  info("GMX V2: reading the created markets");
  const reader = dep("Reader");
  const dataStore = dep("DataStore").address;

  const markets = (await publicClient.readContract({
    address: reader.address,
    abi: reader.abi,
    functionName: "getMarkets",
    args: [dataStore, 0n, 100n],
  })) as readonly {
    marketToken: Address;
    indexToken: Address;
    longToken: Address;
    shortToken: Address;
  }[];

  assert(markets.length > 0, "no markets were created");
  ok("market count", String(markets.length));

  const recorded = markets.slice(0, 20).map((m) => ({
    marketToken: m.marketToken,
    indexToken: m.indexToken,
    longToken: m.longToken,
    shortToken: m.shortToken,
  }));
  setProtocol("gmxV2", { marketCount: markets.length, markets: recorded });
  // Show the first market as a representative
  ok("first market", recorded[0].marketToken);
  return recorded;
}
