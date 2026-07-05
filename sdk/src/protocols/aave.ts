import {
  encodeFunctionData,
  maxUint256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { AAVE, TOKENS, stableBalanceOf } from "../constants.js";
import { marketsFor, tokenInfo } from "../markets.js";
import {
  accountAddress,
  fundWallet,
  increaseTime,
  mine,
  sendAndMine,
  sendAsImpersonated,
} from "../chain.js";
import { erc20Abi } from "../abis.js";
import type {
  AaveObservation,
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { approveTx } from "./uniswap.js";
import { deployContract } from "./deploy.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const VARIABLE_RATE = 2n;
const AAVE_PRICE_UNIT = 10n ** 8n; // $1 = 1e8

export function toAavePrice(usd: number): bigint {
  const P = 1_000_000n;
  return (BigInt(Math.round(usd * Number(P))) * AAVE_PRICE_UNIT) / P;
}

export const aavePoolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

export const aaveAddressesProviderAbi = parseAbi([
  "function getPoolConfigurator() view returns (address)",
]);

export const aavePoolConfiguratorAbi = parseAbi([
  "function setReserveFlashLoaning(address asset, bool enabled)",
]);

export const aaveDataProviderAbi = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

// Pool.getReserveData returns the "raw" stored values (index/rate/lastUpdate). It does not
// compute interest, so it does not revert even when lastUpdateTimestamp (below) is in the future
// relative to block.timestamp.
// (getUserAccountData / PoolDataProvider.getReserveData compute interest and therefore revert.)
export const aaveReserveDataAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

export const aaveOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function setAssetSources(address[] assets, address[] sources)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);

export const aclManagerAbi = parseAbi([
  "function addPoolAdmin(address admin)",
  "function isPoolAdmin(address admin) view returns (bool)",
]);

export const mockAggregatorAbi = parseAbi([
  "function setAnswer(int256 answer)",
  "function latestAnswer() view returns (int256)",
]);

// Aave uses native USDC as the reserve (settlement stable).
const AAVE_STABLE = TOKENS.USDC.address;
const AAVE_STABLE_SYMBOL: TokenSymbol = "USDC";

// Base symbols enabled for aave (from MARKET_LEGS.aave; WETH only on the default fork).
function aaveBaseSymbols(): TokenSymbol[] {
  return marketsFor("aave").map((m) => m.base);
}

// Symbols of the reserves we read/write (enabled bases + settlement stable).
// [WETH, USDC] on the default fork (matches prior behavior).
function aaveReserveSymbols(): TokenSymbol[] {
  return [...aaveBaseSymbols(), AAVE_STABLE_SYMBOL];
}

// Symbol -> reserve address. The stable is native USDC; everything else uses the registry address.
function aaveAsset(symbol: TokenSymbol): Address {
  return symbol === AAVE_STABLE_SYMBOL
    ? AAVE_STABLE
    : tokenInfo(symbol).address;
}

type AaveActionType =
  "aaveSupply" | "aaveWithdraw" | "aaveBorrow" | "aaveRepay";
const AAVE_TYPES: AaveActionType[] = [
  "aaveSupply",
  "aaveWithdraw",
  "aaveBorrow",
  "aaveRepay",
];

function requireAmount(
  value: unknown,
  name: string,
  allowMax: boolean,
): string {
  if (allowMax && value === "max") return "max";
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(
      `${name} must be a decimal integer string${allowMax ? ' or "max"' : ""}`,
    );
  return value;
}

// Accept asset as an enabled base / settlement stable symbol. Only WETH/USDC on the default fork.
function parseAsset(value: unknown): TokenSymbol {
  if (typeof value !== "string")
    throw new Error("asset must be a token symbol string");
  const allowed = new Set(aaveReserveSymbols());
  if (!allowed.has(value))
    throw new Error(`asset must be one of ${[...allowed].join(", ")}`);
  return value;
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  const type = obj.type;
  if (typeof type !== "string" || !AAVE_TYPES.includes(type as AaveActionType))
    return null;
  const asset = parseAsset(obj.asset);
  const allowMax = type === "aaveWithdraw" || type === "aaveRepay";
  const amount = requireAmount(obj.amount, "amount", allowMax);
  const action = { type, asset, amount } as unknown as LeafAction;
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    if (
      typeof obj.maxPriorityFeePerGasWei !== "string" ||
      !DECIMAL_INTEGER.test(obj.maxPriorityFeePerGasWei)
    ) {
      throw new Error(
        "maxPriorityFeePerGasWei must be a decimal integer string",
      );
    }
    (action as { maxPriorityFeePerGasWei?: string }).maxPriorityFeePerGasWei =
      obj.maxPriorityFeePerGasWei;
  }
  return action;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (!AAVE_TYPES.includes(action.type as AaveActionType))
    return { ok: false, reason: "not an aave action" };
  const a = action as {
    type: AaveActionType;
    asset: TokenSymbol;
    amount: string;
  };
  // The stable uses the aggregated USDC-equivalent balance; bases use the bases map (WETH equals wethWei for compatibility).
  const assetBalance = (): bigint =>
    a.asset === AAVE_STABLE_SYMBOL
      ? stableBalanceOf(balances, AAVE_STABLE)
      : (balances.bases?.[a.asset] ?? balances.wethWei);
  if (a.amount !== "max") {
    const amount = BigInt(a.amount);
    if (amount <= 0n) return { ok: false, reason: "amount must be positive" };
    if (a.type === "aaveSupply") {
      if (amount > assetBalance())
        return { ok: false, reason: "supply amount exceeds balance" };
      // ADR 0013: apply the supply limit to every base. WETH=maxAaveSupplyWethWei; additional bases use
      // limits.baseLimits[asset] ("0"=no limit). Stable assets have no supply limit (as before).
      if (a.asset !== AAVE_STABLE_SYMBOL) {
        const maxSupply =
          a.asset === "WETH"
            ? BigInt(obs.limits.maxAaveSupplyWethWei)
            : BigInt(
                obs.limits.baseLimits?.[a.asset]?.maxAaveSupplyBaseWei ?? "0",
              );
        if (maxSupply > 0n && amount > maxSupply)
          return { ok: false, reason: "supply exceeds configured limit" };
      }
    }
    if (a.type === "aaveRepay") {
      if (amount > assetBalance())
        return { ok: false, reason: "repay amount exceeds balance" };
    }
    if (
      a.type === "aaveBorrow" &&
      a.asset === "USDC" &&
      amount > BigInt(obs.limits.maxAaveBorrowUsdcUnits)
    ) {
      return { ok: false, reason: "borrow exceeds configured USDC limit" };
    }
  }
  return { ok: true };
}

function buildTx(owner: Address, action: LeafAction): BuiltTx {
  const a = action as {
    type: AaveActionType;
    asset: TokenSymbol;
    amount: string;
  };
  const asset = aaveAsset(a.asset);
  const amount = a.amount === "max" ? maxUint256 : BigInt(a.amount);
  if (a.type === "aaveSupply") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "supply",
        args: [asset, amount, owner, 0],
      }),
    };
  }
  if (a.type === "aaveWithdraw") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "withdraw",
        args: [asset, amount, owner],
      }),
    };
  }
  if (a.type === "aaveBorrow") {
    return {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "borrow",
        args: [asset, amount, VARIABLE_RATE, 0, owner],
      }),
    };
  }
  return {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [asset, amount, VARIABLE_RATE, owner],
    }),
  };
}

async function userReserve(
  publicClient: PublicClient,
  asset: Address,
  user: Address,
): Promise<{ supplied: bigint; borrowed: bigint }> {
  const r = (await publicClient.readContract({
    address: AAVE.PoolDataProvider,
    abi: aaveDataProviderAbi,
    functionName: "getUserReserveData",
    args: [asset, user],
  })) as readonly bigint[];
  return { supplied: r[0], borrowed: r[2] };
}

// Read the reserves the orderflow bot's Aave state machine needs.
// Flow generation itself lives in the bot process, but the RPC reads are done by the coordinator and passed via FlowContext.
export async function readAaveFlowReserves(
  publicClient: PublicClient,
  wallet: Address,
): Promise<{ wethSupplied: bigint; usdcBorrowed: bigint }> {
  // Two independent reads, so parallelize to reduce RPC latency.
  const [weth, usdc] = await Promise.all([
    userReserve(publicClient, TOKENS.WETH.address, wallet),
    userReserve(publicClient, AAVE_STABLE, wallet),
  ]);
  return { wethSupplied: weth.supplied, usdcBorrowed: usdc.borrowed };
}

// The reserve's last-update timestamp (raw stored value; no interest computation, so it does not revert even if in the future).
async function reserveLastUpdate(
  publicClient: PublicClient,
  asset: Address,
): Promise<bigint> {
  const r = (await publicClient.readContract({
    address: AAVE.Pool,
    abi: aaveReserveDataAbi,
    functionName: "getReserveData",
    args: [asset],
  })) as { lastUpdateTimestamp: number | bigint };
  return BigInt(r.lastUpdateTimestamp);
}

// Align time on the Aave fork. When Arbitrum is forked with anvil, a block's
// block.timestamp can end up earlier than a reserve's lastUpdateTimestamp
// (a mismatch between the fork block's timestamp and the state snapshot; happens intermittently).
// In that state Aave's interest computation `dt = block.timestamp - lastUpdateTimestamp`
// underflows the uint (panic 0x11), so getUserAccountData / getReserveData revert
// and the whole sim crashes on the first observe.
// Fix: read the lastUpdateTimestamp of the WETH/USDC reserves we use, and if block.timestamp is
// at or below it (dt<=0), advance EVM time until it exceeds it. This keeps Aave reads during the
// round loop always at dt>0, so aave strategies can be evaluated over long runs (without intermittent crashes).
// If resetFork does a re-fork with forking, block.timestamp is normally after lastUpdate so this
// does not fire, but depending on the fork block the order can rarely invert, so we keep it as a guard.
const AAVE_WARP_BUFFER_SECONDS = 3600n; // 1h. Margin to keep dt>0 stable when it fires.
const LOCAL_FLASH_LIQUIDITY_USDC_UNITS = 100_000n * 10n ** 6n;
async function warpPastReserveLastUpdate(ctx: SimContext): Promise<void> {
  // Read the lastUpdate of the enabled reserves ([WETH, USDC] on the default fork) and go past their max.
  const updates = await Promise.all(
    aaveReserveSymbols().map((sym) =>
      reserveLastUpdate(ctx.publicClient, aaveAsset(sym)),
    ),
  );
  const maxUpdate = updates.reduce((m, u) => (u > m ? u : m), 0n);
  const now = (await ctx.publicClient.getBlock()).timestamp;
  if (now > maxUpdate) return; // dt>0 already (healthy fork block) -> nothing to do
  await increaseTime(
    ctx.publicClient,
    Number(maxUpdate - now + AAVE_WARP_BUFFER_SECONDS),
  );
  await mine(ctx.publicClient);
}

async function enableLocalFlashLoaning(ctx: SimContext): Promise<void> {
  if (!ctx.config.localDeploy) return;
  const configurator = (await ctx.publicClient.readContract({
    address: AAVE.PoolAddressesProvider,
    abi: aaveAddressesProviderAbi,
    functionName: "getPoolConfigurator",
  })) as Address;
  // Enable the flashloan flag on the enabled reserves ([WETH, USDC] on the default fork).
  for (const sym of aaveReserveSymbols()) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: configurator,
        data: encodeFunctionData({
          abi: aavePoolConfiguratorAbi,
          functionName: "setReserveFlashLoaning",
          args: [aaveAsset(sym), true],
        }),
      },
    );
  }
}

async function seedLocalFlashLoanLiquidity(ctx: SimContext): Promise<void> {
  if (!ctx.config.localDeploy) return;
  const current = (await ctx.publicClient.readContract({
    address: AAVE_STABLE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [AAVE.Pool],
  })) as bigint;
  if (current >= LOCAL_FLASH_LIQUIDITY_USDC_UNITS) return;
  const missing = LOCAL_FLASH_LIQUIDITY_USDC_UNITS - current;

  await fundWallet(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    0n,
    0n,
    missing,
  );
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: AAVE_STABLE,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [AAVE.Pool, missing],
      }),
    },
  );
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: AAVE.Pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "supply",
        args: [AAVE_STABLE, missing, accountAddress(ctx.adminPk), 0],
      }),
    },
  );
}

export const aaveAdapter: ProtocolAdapter = {
  id: "aave",
  stableToken: AAVE_STABLE,
  parse,
  bundleable: () => true,
  validate,

  async readState() {
    return {};
  },

  async observe(ctx, _state, agent): Promise<AaveObservation> {
    // Read supplied/borrowed for each enabled reserve ([WETH, USDC] on the default fork).
    const reserveSymbols = aaveReserveSymbols();
    const [account, reserves, poolUsdc] = await Promise.all([
      ctx.publicClient.readContract({
        address: AAVE.Pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [agent],
      }) as Promise<readonly bigint[]>,
      Promise.all(
        reserveSymbols.map((sym) =>
          userReserve(ctx.publicClient, aaveAsset(sym), agent),
        ),
      ),
      ctx.publicClient.readContract({
        address: AAVE_STABLE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [AAVE.Pool],
      }) as Promise<bigint>,
    ]);
    const supplied: Partial<Record<TokenSymbol, string>> = {};
    const borrowed: Partial<Record<TokenSymbol, string>> = {};
    reserveSymbols.forEach((sym, i) => {
      supplied[sym] = reserves[i].supplied.toString();
      borrowed[sym] = reserves[i].borrowed.toString();
    });
    return {
      healthFactor: account[5].toString(),
      totalCollateralBase: account[0].toString(),
      totalDebtBase: account[1].toString(),
      availableBorrowsBase: account[2].toString(),
      supplied,
      borrowed,
      poolLiquidity: {
        USDC: poolUsdc.toString(),
      },
    };
  },

  async buildTxs(_ctx, owner, action): Promise<BuiltTx[]> {
    return [buildTx(owner, action)];
  },

  async valueUsdc(ctx, agent): Promise<number> {
    const account = (await ctx.publicClient.readContract({
      address: AAVE.Pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [agent],
    })) as readonly bigint[];
    // The base currency is USD with 8 decimals. net = collateral - debt converted to dollars (USDC-equivalent).
    // Collateral (aToken) is outside the wallet and borrows (USDC) are already counted inside it, so net cancels double-counting.
    const net = account[0] - account[1];
    return Number(net) / 1e8;
  },

  async setupWallet(): Promise<BuiltTx[]> {
    // Approve the enabled reserves ([WETH, USDC] on the default fork) to the Pool. Dedup.
    const seen = new Set<string>();
    const txs: BuiltTx[] = [];
    for (const sym of aaveReserveSymbols()) {
      const token = aaveAsset(sym);
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      txs.push(approveTx(token, AAVE.Pool));
    }
    return txs;
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    // Correct the fork's time skew (prevents interest-computation underflow from negative dt).
    // Keeps subsequent Aave reads during setup / the round loop always valid.
    await warpPastReserveLastUpdate(ctx);
    // For each enabled reserve ([WETH, USDC] on the default fork), inject a mock aggregator
    // seeded with the current Aave oracle price (for continuity). Order follows aaveReserveSymbols().
    const reserveSymbols = aaveReserveSymbols();
    const reserveAssets = reserveSymbols.map(aaveAsset);
    const currentPrices = (await Promise.all(
      reserveAssets.map((asset) =>
        ctx.publicClient.readContract({
          address: AAVE.AaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [asset],
        }),
      ),
    )) as bigint[];
    // deployContract auto-assigns the admin nonce, so deploying aggregators for multiple bases (WBTC etc.)
    // in parallel with Promise.all causes a same-nonce collision (replacement transaction underpriced).
    // Deploy serially to stay safe regardless of the number of bases (ADR 0013).
    const aggregators: Address[] = [];
    for (const price of currentPrices) {
      aggregators.push(await deployContract(ctx, "MockAggregator", [price]));
    }

    // Grant POOL_ADMIN (when needed)
    const isAdmin = (await ctx.publicClient.readContract({
      address: AAVE.AclManager,
      abi: aclManagerAbi,
      functionName: "isPoolAdmin",
      args: [admin],
    })) as boolean;
    if (!isAdmin) {
      await sendAsImpersonated(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        AAVE.AclAdmin,
        {
          to: AAVE.AclManager,
          data: encodeFunctionData({
            abi: aclManagerAbi,
            functionName: "addPoolAdmin",
            args: [admin],
          }),
        },
      );
    }

    // Swap to the mocks via setAssetSources (replace all enabled reserves at once)
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: AAVE.AaveOracle,
        data: encodeFunctionData({
          abi: aaveOracleAbi,
          functionName: "setAssetSources",
          args: [reserveAssets, aggregators],
        }),
      },
    );

    reserveAssets.forEach((asset, i) => {
      ctx.oracle.aaveAggregators[asset.toLowerCase()] = aggregators[i];
    });

    // The bundled deployer/'s shared WETH/USDC reserve has supply/borrow enabled, but the
    // flashloan flag defaults to false, so FlashArb stalls with Aave error 91.
    await enableLocalFlashLoaning(ctx);
    // Local realtime setup reverts to the snapshot on every run, so re-seed the pool liquidity for
    // flashloans in setupGlobal too. Without this, a profitable signal hits the Pool's insufficient
    // ERC20 balance and fails with `MockERC20: insufficient balance`.
    await seedLocalFlashLoanLiquidity(ctx);
  },
};
