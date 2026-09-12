// New tokens listing mid-run, and the demand that gives a listing a value (issue #29).
//
// At the window's start the environment lists each token of the event through its own Uniswap V3
// factory -- deploy, approve, create-and-initialize at 1.00 USDC, seed a full-range position -- so
// it surfaces through the #40 registry like any agent-made market. Then, per token, a *wave wallet*
// buys the token with USDC over the ramp, holds, and sells a seeded fraction back during the decay.
// A dud sends nothing. Holdings at the bell are worth zero (ADR 0022 axiom 2), so the whole regime
// is: buy before the wave, sell before the sell-back, and pick a token that gets a wave.
//
// Two decisions carried over from the other process events, because both were paid for once:
//
// *Reconciled per block, not applied once.* The schedule says what the wave should have spent by
// this block; the driver reads the wallet's balance back and sends the difference. A dropped block
// costs a block of lag rather than a missed step (`pointEventsAt` shipped the other way and broke).
//
// *Measured against the chain, not against what was submitted.* Every balance is read back, every
// pending transaction is settled before the next one, and a reverted swap is reported rather than
// assumed. The environment's own swaps can lose to an agent in the same block; the schedule has to
// survive that.
//
// Keys: every launch has its own launch wallet and its own wave wallet, both derived from the seed
// the way the flow wallets are. No two senders share a key, so the driver never races the oracle,
// the registrar or the deployer on a nonce.
import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  erc20Abi,
  nonfungiblePositionManagerAbi,
  quoterV2Abi,
  swapRouterAbi,
  uniswapV3FactoryAbi,
} from "@eris/sdk/abis.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import {
  sqrtPriceX96For,
  uniswapFactory,
} from "@eris/sdk/protocols/uniswap.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";
import type {
  EventSchedule,
  ResolvedStressEvent,
  ResolvedTokenLaunch,
} from "./events.js";

// The fee tier every launch pool opens at. 0.3% rather than the environment's 0.05% WETH/USDC tier:
// a thin new market is a different kind of venue from the deep one, and a wider fee is what a
// launch pool on a real chain charges. Tick spacing 60, so the full range is ±887220.
export const LAUNCH_POOL_FEE = 3000;
const LAUNCH_TICK_LOWER = -887220;
const LAUNCH_TICK_UPPER = 887220;
const LAUNCH_TOKEN_DECIMALS = 18;
const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1);

// Gas is pinned on every transaction the driver sends: the listing batch lands in one block and
// each transaction depends on the one before it (the approve targets a token that does not exist
// yet when it is signed), so `eth_estimateGas` would fail against the current state rather than
// the state the transaction will actually run in.
const GAS_DEPLOY = 1_500_000n;
const GAS_APPROVE = 120_000n;
const GAS_CREATE_POOL = 6_000_000n;
const GAS_MINT = 1_200_000n;
const GAS_SWAP = 700_000n;

// The environment is moving the price on purpose; the bound is only against a pathological fill.
const WAVE_SLIPPAGE_BPS = 1_500n;
// Deltas below this fraction of the wave's total are rounding, not schedule.
const MIN_DELTA_BPS = 100n;
// Blocks to wait for a submitted transaction before treating it as lost.
const PENDING_TIMEOUT_BLOCKS = 3;
// How many times a listing that reverted is retried before the launch is given up on.
const LIST_ATTEMPTS = 3;

export const LAUNCH_WALLET_PREFIX = "launch";
export const LAUNCH_WAVE_WALLET_PREFIX = "launch-wave";

export function launchWalletKey(eventIndex: number, index: number): string {
  return `${LAUNCH_WALLET_PREFIX}:${eventIndex}:${index}`;
}
export function launchWaveWalletKey(eventIndex: number, index: number): string {
  return `${LAUNCH_WAVE_WALLET_PREFIX}:${eventIndex}:${index}`;
}

export type LaunchWallet = { address: Address; privateKey: Hex };

type Pending = {
  hash: Hex;
  blockIndex: number;
  kind: "buy" | "sell";
  amountIn: bigint;
  usdcBefore: bigint;
};

export type TokenLaunchState = {
  eventIndex: number;
  index: number;
  event: ResolvedStressEvent;
  launch: ResolvedTokenLaunch;
  launchWallet: LaunchWallet;
  waveWallet: LaunchWallet;
  liquidityUsdcUnits: bigint;
  tokenSupplyWei: bigint;
  waveUsdcUnits: bigint;
  symbol: string;
  phase: "pending" | "listing" | "live" | "failed";
  token?: Address;
  pool?: Address;
  listedAtBlock?: number;
  listAttempts: number;
  listing?: { hashes: Hex[]; blockIndex: number };
  // The wave wallet's USDC when the window opened. Spent = this minus the balance now.
  waveStartUsdc?: bigint;
  // Tokens held when the decay began: the sell-back target is a fraction of this.
  heldAtDecayStart?: bigint;
  pending: Pending | null;
  approved: { usdc: boolean; token: boolean };
  // Measured totals, from settled transactions.
  grossBuyUsdc: bigint;
  tokensSold: bigint;
  sellUsdcReceived: bigint;
  closedReported: boolean;
};

export type TokenLaunchRuntime = {
  launches: TokenLaunchState[];
  usdc: Address;
  factory: Address;
};

// USDC units per whole dollar.
const USDC_UNIT = 10n ** BigInt(TOKENS.USDC.decimals);

/// What every launch of the schedule needs endowed, before any window opens. Pure: the coordinator
/// funds from it and the tests read it.
export function tokenLaunchEndowments(schedule: EventSchedule): Array<{
  eventIndex: number;
  index: number;
  launchKey: string;
  waveKey: string;
  liquidityUsdcUnits: bigint;
  waveUsdcUnits: bigint;
}> {
  return schedule.tokenLaunches().map(({ eventIndex, launch }) => {
    const liquidityUsdcUnits = BigInt(launch.liquidityUsdc) * USDC_UNIT;
    return {
      eventIndex,
      index: launch.index,
      launchKey: launchWalletKey(eventIndex, launch.index),
      waveKey: launchWaveWalletKey(eventIndex, launch.index),
      liquidityUsdcUnits,
      waveUsdcUnits: waveUsdcUnits(launch),
    };
  });
}

// The wave's total USDC, from its multiple of the pool's USDC side. Rounded to whole units on a
// 1e6 grid so two runs of the same scenario endow the same wallet.
export function waveUsdcUnits(launch: ResolvedTokenLaunch): bigint {
  if (launch.dud || launch.waveUsdcMult <= 0) return 0n;
  const mult = BigInt(Math.round(launch.waveUsdcMult * 1_000_000));
  return (BigInt(launch.liquidityUsdc) * USDC_UNIT * mult) / 1_000_000n;
}

/// Stage the launches: resolve wallets, sizes and the factory, and refuse to start on a deployment
/// that cannot host them.
export async function setupTokenLaunch(
  ctx: SimContext,
  schedule: EventSchedule,
  opts: {
    localDeploy: boolean;
    agentMarkets: boolean;
    uniswapEnabled: boolean;
    walletByKey: (key: string) => LaunchWallet;
  },
  logger: RunLogger,
): Promise<TokenLaunchRuntime> {
  if (!opts.localDeploy)
    throw new Error(
      "stress event tokenLaunch requires run.localDeploy: the environment lists tokens through a " +
        "factory it deployed, and a fork's factory is somebody else's (issue #29)",
    );
  if (!opts.uniswapEnabled)
    throw new Error(
      "stress event tokenLaunch needs the uniswap venue in run.protocols: launch pools are Uniswap " +
        "V3 pools and the wave trades through its router (issue #29)",
    );
  if (!opts.agentMarkets)
    throw new Error(
      "stress event tokenLaunch requires agentMarkets.enabled: true. The registry is how a listing " +
        "reaches the agents (issue #40); without it the tokens would list and nobody could see them, " +
        "and the regime would measure nothing (issue #29)",
    );
  const factory = await uniswapFactory(ctx.publicClient);
  if (!factory)
    throw new Error(
      "stress event tokenLaunch: the NonfungiblePositionManager at " +
        `${UNISWAP.nonfungiblePositionManager} does not answer factory(); is uniswap deployed?`,
    );
  // The artifact is read once here so a missing build fails at setup, not on the window's block.
  readForgeArtifact("AgentERC20");
  const launches: TokenLaunchState[] = schedule
    .tokenLaunches()
    .map(({ eventIndex, event, launch }) => {
      const liquidityUsdcUnits = BigInt(launch.liquidityUsdc) * USDC_UNIT;
      return {
        eventIndex,
        index: launch.index,
        event,
        launch,
        launchWallet: opts.walletByKey(
          launchWalletKey(eventIndex, launch.index),
        ),
        waveWallet: opts.walletByKey(
          launchWaveWalletKey(eventIndex, launch.index),
        ),
        liquidityUsdcUnits,
        tokenSupplyWei:
          BigInt(launch.liquidityUsdc) * 10n ** BigInt(LAUNCH_TOKEN_DECIMALS),
        waveUsdcUnits: waveUsdcUnits(launch),
        symbol: `LT${eventIndex}${launch.index}`,
        phase: "pending" as const,
        listAttempts: 0,
        pending: null,
        approved: { usdc: false, token: false },
        grossBuyUsdc: 0n,
        tokensSold: 0n,
        sellUsdcReceived: 0n,
        closedReported: false,
      };
    });
  logger.event({
    type: "stress_token_launch_setup",
    factory,
    fee: LAUNCH_POOL_FEE,
    launches: launches.map((l) => ({
      eventIndex: l.eventIndex,
      index: l.index,
      symbol: l.symbol,
      launchWallet: l.launchWallet.address,
      waveWallet: l.waveWallet.address,
      liquidityUsdc: l.launch.liquidityUsdc,
      startBlock: l.event.startBlock,
      endBlock: l.event.endBlock,
    })),
  });
  return { launches, usdc: TOKENS.USDC.address, factory };
}

export type TokenLaunchSent = {
  hash: Hex;
  from: Address;
  ownerKey: string;
  actionType: string;
};

/// One block of the schedule: list what should be listed, buy what the wave should have bought,
/// sell what the decay should have sold. Returns every transaction it sent, for attribution.
export async function stepTokenLaunch(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  schedule: EventSchedule,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<TokenLaunchSent[]> {
  const sent: TokenLaunchSent[] = [];
  const targets = schedule.tokenLaunchTargetsAt(blockIndex);
  for (const state of runtime.launches) {
    const target = targets.find(
      (t) =>
        t.eventIndex === state.eventIndex && t.launch.index === state.index,
    );
    if (!target || !target.listed) continue;
    try {
      // ---- listing ----
      if (state.phase === "pending" || state.phase === "listing") {
        await advanceListing(
          ctx,
          runtime,
          state,
          blockIndex,
          blockNumber,
          opts,
          logger,
          sent,
        );
      }
      // The window's first block past its end, reported before this block's own work so a wave
      // that is still catching up cannot postpone the report past the run's end.
      if (target.justClosed && !state.closedReported)
        reportClosed(state, blockIndex, logger);
      if (state.phase !== "live") continue;
      // ---- the wave ----
      if (state.pending) {
        const settled = await settlePending(
          ctx,
          runtime,
          state,
          blockIndex,
          logger,
        );
        if (!settled) continue;
      }
      if (state.launch.dud) continue;
      const usdcNow = await balanceOf(
        ctx,
        runtime.usdc,
        state.waveWallet.address,
      );
      if (state.waveStartUsdc === undefined) state.waveStartUsdc = usdcNow;
      const buyTarget = scaleUnits(state.waveUsdcUnits, target.buyFrac);
      const buyDelta =
        buyTarget > state.grossBuyUsdc ? buyTarget - state.grossBuyUsdc : 0n;
      const minDelta = (state.waveUsdcUnits * MIN_DELTA_BPS) / 10_000n;
      if (buyDelta > 0n && buyDelta >= minDelta) {
        const amountIn = buyDelta > usdcNow ? usdcNow : buyDelta;
        if (amountIn > 0n) {
          await sendSwap(
            ctx,
            runtime,
            state,
            "buy",
            amountIn,
            usdcNow,
            blockIndex,
            blockNumber,
            opts,
            logger,
            sent,
          );
          continue;
        }
      }
      // ---- the sell-back ----
      if (target.sellBackFrac > 0 && state.token) {
        const held = await balanceOf(
          ctx,
          state.token,
          state.waveWallet.address,
        );
        if (state.heldAtDecayStart === undefined) state.heldAtDecayStart = held;
        const sellTarget = scaleUnits(
          state.heldAtDecayStart,
          target.sellBackFrac,
        );
        const sellDelta =
          sellTarget > state.tokensSold ? sellTarget - state.tokensSold : 0n;
        const minSell = (state.heldAtDecayStart * MIN_DELTA_BPS) / 10_000n;
        if (sellDelta > 0n && sellDelta >= minSell) {
          const amountIn = sellDelta > held ? held : sellDelta;
          if (amountIn > 0n) {
            await sendSwap(
              ctx,
              runtime,
              state,
              "sell",
              amountIn,
              usdcNow,
              blockIndex,
              blockNumber,
              opts,
              logger,
              sent,
            );
            continue;
          }
        }
      }
    } catch (error) {
      logger.event({
        type: "stress_token_launch_task_failed",
        eventIndex: state.eventIndex,
        index: state.index,
        symbol: state.symbol,
        blockIndex,
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sent;
}

/// Report what each launch did, once the run is over. No teardown: the pools stay (the next
/// scenario starts from the snapshot), and the environment's leftover tokens sit in flow wallets
/// nobody scores.
export function summarizeTokenLaunch(
  runtime: TokenLaunchRuntime,
  logger: RunLogger,
): void {
  for (const state of runtime.launches) {
    logger.event({
      type: "stress_token_launch_summary",
      eventIndex: state.eventIndex,
      index: state.index,
      symbol: state.symbol,
      phase: state.phase,
      token: state.token ?? null,
      pool: state.pool ?? null,
      listedAtBlock: state.listedAtBlock ?? null,
      dud: state.launch.dud,
      liquidityUsdc: state.launch.liquidityUsdc,
      waveUsdcUnits: state.waveUsdcUnits.toString(),
      grossBuyUsdcUnits: state.grossBuyUsdc.toString(),
      tokensSoldWei: state.tokensSold.toString(),
      sellUsdcReceivedUnits: state.sellUsdcReceived.toString(),
      // What the wave left in the agents' hands, net: what it paid minus what it took back out.
      netUsdcPaidUnits: (
        state.grossBuyUsdc - state.sellUsdcReceived
      ).toString(),
    });
  }
}

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

async function advanceListing(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
  sent: TokenLaunchSent[],
): Promise<void> {
  if (state.phase === "listing" && state.listing) {
    // Did the batch land? The mint is last, so its receipt is the whole batch's.
    const last = state.listing.hashes[state.listing.hashes.length - 1];
    let status: "success" | "reverted" | null = null;
    try {
      const receipt = await ctx.publicClient.getTransactionReceipt({
        hash: last,
      });
      status = receipt.status === "success" ? "success" : "reverted";
    } catch {
      status = null;
    }
    if (status === null) {
      if (blockIndex - state.listing.blockIndex < PENDING_TIMEOUT_BLOCKS)
        return;
      logger.event({
        type: "stress_token_launch_stuck",
        eventIndex: state.eventIndex,
        index: state.index,
        symbol: state.symbol,
        blockIndex,
        hashes: state.listing.hashes,
      });
      state.listing = undefined;
      state.phase = "pending";
    } else if (status === "reverted") {
      // Which transaction reverted is in the receipts; the last one is enough to say the listing
      // did not happen, and the retry re-derives everything from a fresh nonce.
      logger.event({
        type: "stress_token_launch_failed",
        eventIndex: state.eventIndex,
        index: state.index,
        symbol: state.symbol,
        blockIndex,
        blockNumber,
        attempt: state.listAttempts,
        hashes: state.listing.hashes,
        error: "listing batch reverted",
      });
      state.listing = undefined;
      state.phase = state.listAttempts >= LIST_ATTEMPTS ? "failed" : "pending";
    } else {
      const pool = (await ctx.publicClient.readContract({
        address: runtime.factory,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [state.token as Address, runtime.usdc, LAUNCH_POOL_FEE],
      })) as Address;
      state.pool = pool;
      state.phase = "live";
      state.listedAtBlock = blockNumber;
      state.listing = undefined;
      // Public facts only: the token, the pool, the depth. Whether a wave follows is the seed's
      // secret until the ramp shows it (issue #29 decision 6).
      logger.event({
        type: "stress_token_launch",
        eventIndex: state.eventIndex,
        index: state.index,
        symbol: state.symbol,
        blockIndex,
        blockNumber,
        token: state.token,
        pool,
        fee: LAUNCH_POOL_FEE,
        liquidityUsdc: state.launch.liquidityUsdc,
        launchWallet: state.launchWallet.address,
        waveWallet: state.waveWallet.address,
      });
      return;
    }
  }
  if (state.phase !== "pending") return;
  if (state.listAttempts >= LIST_ATTEMPTS) {
    state.phase = "failed";
    return;
  }
  state.listAttempts++;
  const hashes = await sendListingBatch(
    ctx,
    runtime,
    state,
    opts.priorityFeeWei,
  );
  state.listing = { hashes, blockIndex };
  state.phase = "listing";
  for (const hash of hashes)
    sent.push({
      hash,
      from: state.launchWallet.address,
      ownerKey: launchWalletKey(state.eventIndex, state.index),
      actionType: "tokenLaunch",
    });
  logger.event({
    type: "stress_token_launch_listing",
    eventIndex: state.eventIndex,
    index: state.index,
    symbol: state.symbol,
    blockIndex,
    blockNumber,
    attempt: state.listAttempts,
    token: state.token,
    hashes,
  });
}

// Deploy, approve both sides to the position manager, create-and-initialize at 1.00 USDC, and
// seed the full range -- five transactions from one key with consecutive nonces, so they land in
// one block in order. The token's address is known before it exists (CREATE is a function of the
// sender and the nonce), which is what lets the approve and the pool creation be signed now.
async function sendListingBatch(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
  priorityFeeWei: bigint,
): Promise<Hex[]> {
  const account = privateKeyToAccount(state.launchWallet.privateKey);
  const nonce = await ctx.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const token = getContractAddress({
    from: account.address,
    nonce: BigInt(nonce),
  });
  state.token = token;
  const { abi, bytecode } = readForgeArtifact("AgentERC20");
  const deployData = encodeDeployData({
    abi,
    bytecode,
    args: [
      `Launch Token ${state.eventIndex}-${state.index}`,
      state.symbol,
      LAUNCH_TOKEN_DECIMALS,
      state.tokenSupplyWei,
    ],
  });
  const [token0, token1] =
    token.toLowerCase() < runtime.usdc.toLowerCase()
      ? [token, runtime.usdc]
      : [runtime.usdc, token];
  const tokenIsToken0 = token0.toLowerCase() === token.toLowerCase();
  const sqrtPriceX96 = sqrtPriceX96For({
    humanPrice: 1,
    token0Decimals: tokenIsToken0
      ? LAUNCH_TOKEN_DECIMALS
      : TOKENS.USDC.decimals,
    token1Decimals: tokenIsToken0
      ? TOKENS.USDC.decimals
      : LAUNCH_TOKEN_DECIMALS,
  });
  const npm = UNISWAP.nonfungiblePositionManager;
  const txs: Array<{ to?: Address; data: Hex; gas: bigint }> = [
    { data: deployData, gas: GAS_DEPLOY },
    { to: token, data: approveData(npm, maxUint256), gas: GAS_APPROVE },
    { to: runtime.usdc, data: approveData(npm, maxUint256), gas: GAS_APPROVE },
    {
      to: npm,
      data: encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: "createAndInitializePoolIfNecessary",
        args: [token0, token1, LAUNCH_POOL_FEE, sqrtPriceX96],
      }),
      gas: GAS_CREATE_POOL,
    },
    {
      to: npm,
      data: encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: "mint",
        args: [
          {
            token0,
            token1,
            fee: LAUNCH_POOL_FEE,
            tickLower: LAUNCH_TICK_LOWER,
            tickUpper: LAUNCH_TICK_UPPER,
            amount0Desired: tokenIsToken0
              ? state.tokenSupplyWei
              : state.liquidityUsdcUnits,
            amount1Desired: tokenIsToken0
              ? state.liquidityUsdcUnits
              : state.tokenSupplyWei,
            // The pool did not exist a moment ago and nobody else holds the token, so there is no
            // price to be moved away from before this lands.
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: account.address,
            deadline: DEADLINE_FAR_FUTURE,
          },
        ],
      }),
      gas: GAS_MINT,
    },
  ];
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hashes: Hex[] = [];
  let n = nonce;
  for (const tx of txs) {
    hashes.push(
      await ctx.walletClient.sendTransaction({
        account,
        chain: ctx.chain,
        ...(tx.to ? { to: tx.to } : {}),
        data: tx.data,
        gas: tx.gas,
        nonce: n++,
        maxFeePerGas: baseFee + priorityFeeWei,
        maxPriorityFeePerGas: priorityFeeWei,
      }),
    );
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// the wave and the sell-back
// ---------------------------------------------------------------------------

async function sendSwap(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
  kind: "buy" | "sell",
  amountIn: bigint,
  usdcBefore: bigint,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
  sent: TokenLaunchSent[],
): Promise<void> {
  const token = state.token as Address;
  const tokenIn = kind === "buy" ? runtime.usdc : token;
  const tokenOut = kind === "buy" ? token : runtime.usdc;
  const account = privateKeyToAccount(state.waveWallet.privateKey);
  let quoted = 0n;
  try {
    const sim = await ctx.publicClient.simulateContract({
      address: UNISWAP.quoterV2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee: LAUNCH_POOL_FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    quoted = sim.result[0];
  } catch (error) {
    logger.event({
      type: "stress_token_launch_quote_failed",
      eventIndex: state.eventIndex,
      index: state.index,
      symbol: state.symbol,
      blockIndex,
      kind,
      amountIn: amountIn.toString(),
      error:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
    return;
  }
  if (quoted <= 0n) return;
  const minOut = (quoted * (10_000n - WAVE_SLIPPAGE_BPS)) / 10_000n;
  const needApprove =
    kind === "buy" ? !state.approved.usdc : !state.approved.token;
  const nonce = await ctx.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  let n = nonce;
  const send = async (to: Address, data: Hex, gas: bigint): Promise<Hex> =>
    ctx.walletClient.sendTransaction({
      account,
      chain: ctx.chain,
      to,
      data,
      gas,
      nonce: n++,
      maxFeePerGas: baseFee + opts.priorityFeeWei,
      maxPriorityFeePerGas: opts.priorityFeeWei,
    });
  const ownerKey = launchWaveWalletKey(state.eventIndex, state.index);
  if (needApprove) {
    // Approve once, for everything the wallet will ever route: it is the environment's own wallet
    // and the router is the environment's own contract.
    const hash = await send(
      tokenIn,
      approveData(UNISWAP.swapRouter, maxUint256),
      GAS_APPROVE,
    );
    sent.push({
      hash,
      from: account.address,
      ownerKey,
      actionType: "tokenLaunchApprove",
    });
    if (kind === "buy") state.approved.usdc = true;
    else state.approved.token = true;
  }
  const hash = await send(
    UNISWAP.swapRouter,
    encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: LAUNCH_POOL_FEE,
          recipient: account.address,
          deadline: DEADLINE_FAR_FUTURE,
          amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    GAS_SWAP,
  );
  sent.push({
    hash,
    from: account.address,
    ownerKey,
    actionType: kind === "buy" ? "tokenLaunchWave" : "tokenLaunchSellBack",
  });
  state.pending = { hash, blockIndex, kind, amountIn, usdcBefore };
  logger.event({
    type:
      kind === "buy"
        ? "stress_token_launch_wave"
        : "stress_token_launch_sellback",
    eventIndex: state.eventIndex,
    index: state.index,
    symbol: state.symbol,
    blockIndex,
    blockNumber,
    pool: state.pool,
    amountIn: amountIn.toString(),
    quotedOut: quoted.toString(),
    hash,
  });
}

async function settlePending(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
  blockIndex: number,
  logger: RunLogger,
): Promise<boolean> {
  const pending = state.pending;
  if (!pending) return true;
  let status: "success" | "reverted" | null = null;
  try {
    const receipt = await ctx.publicClient.getTransactionReceipt({
      hash: pending.hash,
    });
    status = receipt.status === "success" ? "success" : "reverted";
  } catch {
    status = null;
  }
  if (status === null) {
    if (blockIndex - pending.blockIndex < PENDING_TIMEOUT_BLOCKS) return false;
    logger.event({
      type: "stress_token_launch_stuck",
      eventIndex: state.eventIndex,
      index: state.index,
      symbol: state.symbol,
      blockIndex,
      hash: pending.hash,
      submittedAtBlockIndex: pending.blockIndex,
    });
  } else if (status === "reverted") {
    logger.event({
      type: "stress_token_launch_reverted",
      eventIndex: state.eventIndex,
      index: state.index,
      symbol: state.symbol,
      blockIndex,
      kind: pending.kind,
      hash: pending.hash,
    });
  } else if (pending.kind === "buy") {
    state.grossBuyUsdc += pending.amountIn;
  } else {
    state.tokensSold += pending.amountIn;
    const usdcNow = await balanceOf(
      ctx,
      runtime.usdc,
      state.waveWallet.address,
    );
    if (usdcNow > pending.usdcBefore)
      state.sellUsdcReceived += usdcNow - pending.usdcBefore;
  }
  state.pending = null;
  return true;
}

function reportClosed(
  state: TokenLaunchState,
  blockIndex: number,
  logger: RunLogger,
): void {
  state.closedReported = true;
  logger.event({
    type: state.launch.dud
      ? "stress_token_launch_dud"
      : "stress_token_launch_closed",
    eventIndex: state.eventIndex,
    index: state.index,
    symbol: state.symbol,
    blockIndex,
    phase: state.phase,
    token: state.token ?? null,
    pool: state.pool ?? null,
    grossBuyUsdcUnits: state.grossBuyUsdc.toString(),
    tokensSoldWei: state.tokensSold.toString(),
    sellUsdcReceivedUnits: state.sellUsdcReceived.toString(),
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function approveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
}

async function balanceOf(
  ctx: SimContext,
  token: Address,
  holder: Address,
): Promise<bigint> {
  return (await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
}

// A fraction of an integer amount on a 1e9 grid, so two runs of the same scenario reconcile to the
// same target (the same discipline as liquidity.ts's scaleLiquidity).
export function scaleUnits(amount: bigint, frac: number): bigint {
  if (!(frac > 0)) return 0n;
  if (frac >= 1) return amount;
  return (amount * BigInt(Math.round(frac * 1e9))) / 1_000_000_000n;
}
