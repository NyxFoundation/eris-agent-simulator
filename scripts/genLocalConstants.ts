/**
 * Generate src/constants.local.ts from deployments.json (the bundled deployer/'s local-deploy output).
 *
 * Bridges the deterministic addresses from deploying all protocols to a local (non-fork) anvil into the
 * poc constants. constants.ts overlays the generated LOCAL_DEPLOYMENT only when ERIS_LOCAL_DEPLOY=1
 * (on a fork it uses the Arbitrum defaults).
 *
 * Usage:
 *   DEPLOYMENTS_JSON=/path/to/deployments.json \
 *     npm run gen:local-constants
 *
 * The default DEPLOYMENTS_JSON is this repo's bundled deployer/deployments/deployments.json.
 *
 * ADR 0013: if deployments.json has WBTC (tokens.WBTC + each venue's wbtcUsdc* / gmx WBTC market),
 * generate TOKENS.WBTC and the WBTC leg of MARKET_LEGS. Otherwise WETH only (backward compatible).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { deploymentsFingerprint } from "../core/src/backtest/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// index0 of anvil's default mnemonic = deployer. Aave's ACL admin = deployer.
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

type Deployments = {
  chainId: number;
  tokens: Record<string, string>;
  protocols: {
    common?: { multicall3?: string };
    uniswapV3?: Record<string, string>;
    balancerV2?: Record<string, string>;
    curve?: Record<string, string | number>;
    gmxV2?: Record<string, unknown> & {
      markets?: {
        marketToken: string;
        indexToken: string;
        longToken: string;
        shortToken: string;
      }[];
    };
    aaveV3?: Record<string, unknown>;
  };
};

type GmxMarketList = NonNullable<
  NonNullable<Deployments["protocols"]["gmxV2"]>["markets"]
>;

function loadDeployments(explicitPath?: string): {
  path: string;
  data: Deployments;
} {
  const path =
    explicitPath ??
    process.env.DEPLOYMENTS_JSON ??
    resolve(ROOT, "deployer", "deployments", "deployments.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as Deployments;
  return { path, data };
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null)
    throw new Error(`deployments.json is missing ${what}`);
  return v;
}

function ca(v: string | undefined, what: string): Address {
  return getAddress(need(v, what));
}

// ADR 0013: WBTC markets (built if deployments.json has WBTC; undefined otherwise).
type WbtcInfo = {
  token: Address;
  uniPool?: Address;
  balPool?: Address;
  balPoolId?: string;
  balTokens?: Address[];
  curvePool?: Address;
  curveBaseIndex?: number;
  curveQuoteIndex?: number;
  gmxMarket?: Address;
};

// Generate sdk/src/constants.local.ts from deployments.json (factored into a function so it can be
// called both from the CLI itself and from the backtest tooling; ADR 0016). The returned fingerprint
// uses the same computation as the state dump manifest's deploymentsFingerprint (core/src/backtest/shared.ts).
export function generateLocalConstants(deploymentsPath?: string): {
  target: string;
  deploymentsPath: string;
  fingerprint: string;
} {
  const { path, data } = loadDeployments(deploymentsPath);
  const t = data.tokens;
  const p = data.protocols;

  const weth = ca(t.WETH, "tokens.WETH");
  const usdc = ca(t.USDC, "tokens.USDC");
  const usdt = t.USDT ? getAddress(t.USDT) : usdc;

  const uni = need(p.uniswapV3, "protocols.uniswapV3");
  const bal = need(p.balancerV2, "protocols.balancerV2");
  // gmx is optional (allows partial deploys like `deploy --only uniswap,balancer,curve,aave`).
  // If not deployed, fill with the zero address (a run that enables the gmx venue naturally won't work).
  const gmx = p.gmxV2 as
    (Record<string, string> & { markets?: GmxMarketList }) | undefined;
  const aave = need(p.aaveV3, "protocols.aaveV3") as Record<string, string>;
  const multicall3 = ca(p.common?.multicall3, "protocols.common.multicall3");

  // Balancer registers in ascending order. The deployer pool is [WETH, USDC] (80/20).
  const balTokens = (
    weth.toLowerCase() < usdc.toLowerCase() ? [weth, usdc] : [usdc, weth]
  ) as Address[];

  // GMX ETH/USD market = the one with indexToken==WETH (zero if gmx not deployed).
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const markets = gmx ? need(gmx.markets, "gmxV2.markets") : [];
  const ethMarket = markets.find(
    (m) => m.indexToken.toLowerCase() === weth.toLowerCase(),
  );
  const ethUsdMarket = gmx
    ? ca(ethMarket?.marketToken, "gmxV2 ETH/USD market (indexToken==WETH)")
    : ZERO;
  const gmxAddr = (key: string): Address =>
    gmx ? ca(gmx[key], `gmxV2.${key}`) : ZERO;

  // Curve: the deployer stands up a twocrypto-ng WETH/USDC crypto pool (uint256 index).
  // coin0=USDC(stable)=0, coin1=WETH=1. poc CURVE uses the WETH<->stable leg.
  const curveP = p.curve as
    | (Record<string, string | number> & {
        wethUsdcCryptoPool?: string;
        cryptoWethIndex?: number;
        cryptoStableIndex?: number;
        wbtcUsdcCryptoPool?: string;
        cryptoWbtcIndex?: number;
        cryptoWbtcStableIndex?: number;
      })
    | undefined;
  const curve = {
    pool: ca(curveP?.wethUsdcCryptoPool as string, "curve.wethUsdcCryptoPool"),
    wethIndex: Number(need(curveP?.cryptoWethIndex, "curve.cryptoWethIndex")),
    usdtIndex: Number(
      need(curveP?.cryptoStableIndex, "curve.cryptoStableIndex"),
    ),
  };

  // ---- ADR 0013: WBTC (if present, collect each venue's leg; otherwise WETH only) ----
  const wbtc = t.WBTC ? getAddress(t.WBTC) : undefined;
  let wbtcInfo: WbtcInfo | undefined;
  if (wbtc) {
    const wbtcMarket = markets.find(
      (m) => m.indexToken.toLowerCase() === wbtc.toLowerCase(),
    );
    const balWbtcTokens = (
      wbtc.toLowerCase() < usdc.toLowerCase() ? [wbtc, usdc] : [usdc, wbtc]
    ) as Address[];
    wbtcInfo = {
      token: wbtc,
      uniPool: uni.wbtcUsdcPool ? getAddress(uni.wbtcUsdcPool) : undefined,
      balPool: bal.wbtcUsdcPool ? getAddress(bal.wbtcUsdcPool) : undefined,
      balPoolId: bal.wbtcUsdcPoolId,
      balTokens: balWbtcTokens,
      curvePool: curveP?.wbtcUsdcCryptoPool
        ? getAddress(curveP.wbtcUsdcCryptoPool)
        : undefined,
      curveBaseIndex:
        curveP?.cryptoWbtcIndex !== undefined
          ? Number(curveP.cryptoWbtcIndex)
          : undefined,
      curveQuoteIndex:
        curveP?.cryptoWbtcStableIndex !== undefined
          ? Number(curveP.cryptoWbtcStableIndex)
          : undefined,
      gmxMarket: wbtcMarket?.marketToken
        ? getAddress(wbtcMarket.marketToken)
        : undefined,
    };
  }

  const fingerprint = deploymentsFingerprint(data);
  const out = render({
    deploymentsPath: path,
    fingerprint,
    chainId: data.chainId,
    weth,
    usdc,
    usdt,
    multicall3,
    uni: {
      pool: ca(uni.wethUsdcPool, "uniswapV3.wethUsdcPool"),
      swapRouter: ca(uni.swapRouter, "uniswapV3.swapRouter"),
      npm: ca(uni.positionManager, "uniswapV3.positionManager"),
      quoterV2: ca(uni.quoterV2, "uniswapV3.quoterV2"),
    },
    bal: {
      vault: ca(bal.vault, "balancerV2.vault"),
      queries: ca(bal.queries, "balancerV2.queries"),
      pool: ca(bal.wethUsdcPool, "balancerV2.wethUsdcPool"),
      poolId: need(bal.wethUsdcPoolId, "balancerV2.wethUsdcPoolId"),
      tokens: balTokens,
    },
    curve,
    gmx: {
      RoleStore: gmxAddr("RoleStore"),
      DataStore: gmxAddr("DataStore"),
      Oracle: gmxAddr("Oracle"),
      EventEmitter: gmxAddr("EventEmitter"),
      Router: gmxAddr("Router"),
      ExchangeRouter: gmxAddr("ExchangeRouter"),
      OrderHandler: gmxAddr("OrderHandler"),
      OrderVault: gmxAddr("OrderVault"),
      LiquidationHandler: gmxAddr("LiquidationHandler"),
      Reader: gmxAddr("Reader"),
      Config: gmxAddr("Config"),
    },
    ethUsdMarket,
    aave: {
      PoolAddressesProvider: ca(
        aave.poolAddressesProvider,
        "aaveV3.poolAddressesProvider",
      ),
      Pool: ca(aave.pool, "aaveV3.pool"),
      AaveOracle: ca(aave.aaveOracle, "aaveV3.aaveOracle"),
      AclAdmin: DEPLOYER,
      AclManager: ca(aave.aclManager, "aaveV3.aclManager"),
      PoolDataProvider: ca(aave.poolDataProvider, "aaveV3.poolDataProvider"),
    },
    wbtc: wbtcInfo,
  });

  const target = resolve(ROOT, "sdk", "src", "constants.local.ts");
  writeFileSync(target, out);
  console.log(`✓ generated: ${target}`);
  console.log(`  input: ${path} (chainId=${data.chainId})`);
  console.log(`  fingerprint: ${fingerprint}`);
  console.log(`  WETH=${weth} USDC=${usdc} Multicall3=${multicall3}`);
  if (wbtcInfo) {
    console.log(
      `  WBTC=${wbtcInfo.token} (uni=${wbtcInfo.uniPool ?? "-"} bal=${wbtcInfo.balPool ?? "-"} curve=${wbtcInfo.curvePool ?? "-"} gmx=${wbtcInfo.gmxMarket ?? "-"})`,
    );
  } else {
    console.log(`  WBTC: none (WETH only. MARKET_LEGS is WETH-only)`);
  }
  console.log(`  local run: set ERIS_LOCAL_DEPLOY=1 to use`);
  return { target, deploymentsPath: path, fingerprint };
}

function render(d: {
  deploymentsPath: string;
  fingerprint: string;
  chainId: number;
  weth: Address;
  usdc: Address;
  usdt: Address;
  multicall3: Address;
  uni: { pool: Address; swapRouter: Address; npm: Address; quoterV2: Address };
  bal: {
    vault: Address;
    queries: Address;
    pool: Address;
    poolId: string;
    tokens: Address[];
  };
  curve: { pool: Address; wethIndex: number; usdtIndex: number };
  gmx: Record<string, Address>;
  ethUsdMarket: Address;
  aave: Record<string, Address>;
  wbtc?: WbtcInfo;
}): string {
  const a = (x: string) => `"${x}" as Address`;
  const w = d.wbtc;

  // ---- TOKENS' WBTC entry (if any) ----
  const tokensWbtc = w
    ? `\n    WBTC: { address: ${a(w.token)}, decimals: 8 },`
    : "";

  // ---- MARKET_LEGS (WETH + WBTC leg. The WBTC leg is included only for venues whose addresses are all present) ----
  const uniWbtc = w?.uniPool
    ? `\n      WBTC: { pool: ${a(w.uniPool)}, fee: 3000, tickSpacing: 60 },`
    : "";
  const balWbtc =
    w?.balPool && w?.balPoolId
      ? `\n      WBTC: { poolId: "${w.balPoolId}" as \`0x\${string}\`, tokens: [${w.balTokens!.map(a).join(", ")}], stable: ${a(d.usdc)} },`
      : "";
  const curveWbtc =
    w?.curvePool &&
    w?.curveBaseIndex !== undefined &&
    w?.curveQuoteIndex !== undefined
      ? `\n      WBTC: { pool: ${a(w.curvePool)}, baseIndex: ${w.curveBaseIndex}, quoteIndex: ${w.curveQuoteIndex}, stable: ${a(d.usdc)} },`
      : "";
  const gmxWbtc = w?.gmxMarket
    ? `\n      WBTC: { market: ${a(w.gmxMarket)} },`
    : "";
  const aaveWbtc = w ? `\n      WBTC: {},` : "";

  const marketLegs = `
  MARKET_LEGS: {
    uniswap: {
      WETH: { pool: ${a(d.uni.pool)}, fee: 3000, tickSpacing: 60 },${uniWbtc}
    },
    balancer: {
      WETH: { poolId: "${d.bal.poolId}" as \`0x\${string}\`, tokens: [${d.bal.tokens.map(a).join(", ")}], stable: ${a(d.usdc)} },${balWbtc}
    },
    curve: {
      WETH: { pool: ${a(d.curve.pool)}, baseIndex: ${d.curve.wethIndex}, quoteIndex: ${d.curve.usdtIndex}, stable: ${a(d.usdc)} },${curveWbtc}
    },
    gmx: {
      WETH: { market: ${a(d.ethUsdMarket)} },${gmxWbtc}
    },
    aave: {
      WETH: {},${aaveWbtc}
    },
  },`;

  return `// AUTO-GENERATED by scripts/genLocalConstants.ts — do not edit by hand.
// Input: ${d.deploymentsPath}
// Deterministic addresses from deploying all protocols to a local (non-fork) anvil.
// constants.ts overlays these only when ERIS_LOCAL_DEPLOY=1.
import type { Address } from "viem";
import type { MarketLegs } from "./types.js";

// Canonical fingerprint of the source deployments.json (ADR 0016 §2). The backtest CLI
// compares it against the state dump manifest and, on mismatch, regenerates from the manifest's bundled deployments.
export const DEPLOYMENTS_FINGERPRINT = "${d.fingerprint}";

export type LocalDeployment = {
  CHAIN_ID: number;
  TOKENS: {
    WETH: { address: Address; decimals: number };
    USDC: { address: Address; decimals: number };
    WBTC?: { address: Address; decimals: number };
  };
  USDC_VARIANTS: { native: Address; bridged: Address; usdt: Address };
  UNISWAP: {
    poolWethUsdc500: Address;
    swapRouter: Address;
    nonfungiblePositionManager: Address;
    quoterV2: Address;
    fee: number;
    tickSpacing: number;
  };
  MULTICALL3: Address;
  BALANCER: {
    vault: Address;
    queries: Address;
    pool: Address;
    poolId: \`0x\${string}\`;
    tokens: Address[];
    usdcToken: Address;
    seedWethWei: bigint;
    seedUsdcUnits: bigint;
    seedUsdtUnits: bigint;
  };
  CURVE: { pool: Address; wethIndex: number; usdtIndex: number; usdcToken: Address };
  GMX: {
    RoleStore: Address; DataStore: Address; Oracle: Address; EventEmitter: Address;
    Router: Address; ExchangeRouter: Address; OrderHandler: Address; OrderVault: Address;
    LiquidationHandler: Address; Reader: Address; Config: Address;
  };
  GMX_MARKETS: { ETH_USD: Address };
  AAVE: {
    PoolAddressesProvider: Address; Pool: Address; AaveOracle: Address;
    AclAdmin: Address; AclManager: Address; PoolDataProvider: Address;
  };
  // ADR 0013: multi-asset market legs (WBTC etc.). Includes the WBTC leg if WBTC is in deployments.json.
  MARKET_LEGS?: MarketLegs;
};

export const LOCAL_DEPLOYMENT: LocalDeployment | null = {
  CHAIN_ID: ${d.chainId},
  TOKENS: {
    WETH: { address: ${a(d.weth)}, decimals: 18 },
    USDC: { address: ${a(d.usdc)}, decimals: 6 },${tokensWbtc}
  },
  // Local uses a single USDC/USDT. native/bridged are the same USDC; usdt maps to USDT.
  USDC_VARIANTS: {
    native: ${a(d.usdc)},
    bridged: ${a(d.usdc)},
    usdt: ${a(d.usdt)},
  },
  UNISWAP: {
    poolWethUsdc500: ${a(d.uni.pool)},
    swapRouter: ${a(d.uni.swapRouter)},
    nonfungiblePositionManager: ${a(d.uni.npm)},
    quoterV2: ${a(d.uni.quoterV2)},
    // The deployer's WETH/USDC pool is fee=3000 (0.3%) / tickSpacing=60.
    fee: 3000,
    tickSpacing: 60,
  },
  MULTICALL3: ${a(d.multicall3)},
  BALANCER: {
    vault: ${a(d.bal.vault)},
    queries: ${a(d.bal.queries)},
    pool: ${a(d.bal.pool)},
    poolId: "${d.bal.poolId}" as \`0x\${string}\`,
    // The deployer pool is 2 tokens [WETH, USDC] (80/20). There is no USDT leg.
    tokens: [${d.bal.tokens.map((x) => a(x)).join(", ")}],
    usdcToken: ${a(d.usdc)},
    seedWethWei: 100_000_000_000_000_000_000n,
    seedUsdcUnits: 50_000_000_000n,
    seedUsdtUnits: 0n,
  },
  // Curve: twocrypto-ng's WETH/USDC crypto pool (uint256 index get_dy/exchange).
  // coin0=USDC(stable)=${d.curve.usdtIndex}, coin1=WETH=${d.curve.wethIndex}. usdcToken is the pool's stable=USDC.
  CURVE: {
    pool: ${a(d.curve.pool)},
    wethIndex: ${d.curve.wethIndex},
    usdtIndex: ${d.curve.usdtIndex},
    usdcToken: ${a(d.usdc)},
  },
  GMX: {
    RoleStore: ${a(d.gmx.RoleStore)},
    DataStore: ${a(d.gmx.DataStore)},
    Oracle: ${a(d.gmx.Oracle)},
    EventEmitter: ${a(d.gmx.EventEmitter)},
    Router: ${a(d.gmx.Router)},
    ExchangeRouter: ${a(d.gmx.ExchangeRouter)},
    OrderHandler: ${a(d.gmx.OrderHandler)},
    OrderVault: ${a(d.gmx.OrderVault)},
    LiquidationHandler: ${a(d.gmx.LiquidationHandler)},
    Reader: ${a(d.gmx.Reader)},
    Config: ${a(d.gmx.Config)},
  },
  GMX_MARKETS: { ETH_USD: ${a(d.ethUsdMarket)} },
  AAVE: {
    PoolAddressesProvider: ${a(d.aave.PoolAddressesProvider)},
    Pool: ${a(d.aave.Pool)},
    AaveOracle: ${a(d.aave.AaveOracle)},
    AclAdmin: ${a(d.aave.AclAdmin)},
    AclManager: ${a(d.aave.AclManager)},
    PoolDataProvider: ${a(d.aave.PoolDataProvider)},
  },${marketLegs}
};
`;
}

// Run generation only when executed directly (npm run gen:local-constants).
// When imported from genStateDump etc., the caller invokes generateLocalConstants.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  generateLocalConstants();
}
