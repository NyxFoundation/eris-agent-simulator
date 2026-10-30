// New tokens listing mid-run, and the demand that gives a listing a value (issue #29).
//
// At the window's start the environment lists each token of the event through its own Uniswap V3
// factory -- deploy, create and initialize at 1.00 USDC, seed a full-range position, all in one call
// to the environment's TokenLauncher (contracts/TokenLauncher.sol) -- so it surfaces through the #40
// registry like any agent-made market. Then, per token, a *wave wallet*
// buys the token with USDC over the ramp, holds, and sells a seeded fraction back during the decay.
// A dud sends nothing. Holdings at the bell are worth zero (ADR 0022 axiom 2), so the whole regime
// is: buy before the wave, sell before the sell-back, and pick a token that gets a wave. With the
// event's waveStopProb each token's ramp is memoryless (events.ts drawWaveLengths): the same buy every
// block until a stop nobody can see coming, and the hold and the sell-back counted from that stop.
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
//
// *One transaction, under a secret address.* The listing used to be five transactions from the launch
// wallet, the first a CREATE whose address follows from the wallet and its nonce -- both public from
// block 0, and the nonce does not move until the window. The Uniswap factory does not check that a
// token has code, so anyone could create and initialize the future token's pool at a price of their
// choosing; `createAndInitializePoolIfNecessary` then skipped the initialize and the zero-minimum mint
// went in at that price (measured on anvil: the whole supply against 0.000001 USDC, bought back for
// 1 USDC and sold to the wave for ~37k). Now the launcher deploys the token with CREATE2 under a salt
// derived from the environment's wallet secret (launchSalt), refuses if the pool already exists, and
// creates, initializes and mints in the same transaction, with non-zero minimums.
import {
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  erc20Abi,
  poolAbi,
  quoterV2Abi,
  swapRouterAbi,
  uniswapV3FactoryAbi,
} from "@eris/sdk/abis.js";
import { sendBatch } from "@eris/sdk/chain.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import {
  sqrtPriceX96For,
  uniswapFactory,
} from "@eris/sdk/protocols/uniswap.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";
import { environmentKey } from "../walletKeys.js";
import { requireStandingApprovals } from "./standingApprovals.js";
import {
  FLAT_FEE_MEDIAN_WEI,
  LAUNCH_WAVE_SLIPPAGE_BPS,
  impactValueUsd,
  probeAmount,
  type EnvBid,
  type EnvBidContext,
} from "./envBid.js";
import {
  launchSellBackFrac,
  waveLengthMean,
  type EventSchedule,
  type ResolvedStressEvent,
  type ResolvedTokenLaunch,
  type StressEventConfig,
  type TokenLaunchTarget,
} from "./events.js";

// The fee tier every launch pool opens at. 0.3% rather than the environment's 0.05% WETH/USDC tier:
// a thin new market is a different kind of venue from the deep one, and a wider fee is what a
// launch pool on a real chain charges. Tick spacing 60, so the full range is ±887220.
export const LAUNCH_POOL_FEE = 3000;
export const LAUNCH_TICK_LOWER = -887220;
export const LAUNCH_TICK_UPPER = 887220;
export const LAUNCH_TOKEN_DECIMALS = 18;

// What the coordinator checks the TokenLauncher artifact declares before deploying it.
export const TOKEN_LAUNCHER_REQUIRED_FUNCTIONS = ["launch", "isCaller"];

export const tokenLauncherEventAbi = parseAbi([
  "event Launched(address indexed caller, address indexed token, address indexed pool, uint256 tokenId, uint256 tokenSupply, uint256 usdcDeposited, uint256 tokenDeposited, uint128 liquidity)",
]);

// The wave stops buying once the pool prices the token above this multiple of its 1.00 USDC listing.
//
// The honest path rarely gets near it. The pool is a full-range position, so its price is
// (USDC in the pool / USDC seeded)^2; the largest expected wave config/regimes/launch.yaml can draw is
// 1.0x the seeded USDC, which on its own ends at 4x, and one block of the ramp moves the price
// ~+8.6%. 10x is ~2.16x of the pool's depth bought: room for the field to buy ~1.16x ahead of such a
// wave, and the end of the longest memoryless waves on their own (a wave that runs to the length cap
// spends up to 3.15x its expected total; 2.9% of waves stop here with nobody ahead of them,
// scripts/measureLaunchFrontRun.ts). What it bounds is the other case: a pool somebody has bought out
// (or priced) so far that the wave would be paying for nothing -- the exploit this file was rewritten
// for paid 37,500 USDC for 6.5e-14 tokens. A demand that stops at some price is also simply what
// demand is, so a wave that finds the pool above the cap ends there for good (waveTargets).
export const WAVE_PRICE_CAP_MULT = 10;
// The listing price, USDC per whole token.
export const LAUNCH_LISTING_PRICE_USDC = 1;
const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1);

// Gas is pinned on every transaction the driver sends: the listing batch lands in one block and
// each transaction depends on the one before it (the approve targets a token that does not exist
// yet when it is signed), so `eth_estimateGas` would fail against the current state rather than
// the state the transaction will actually run in.
// The launcher call: CREATE2 of the token (~0.7M), createPool (~4.6M), initialize and the mint.
const GAS_LAUNCH = 9_000_000n;
const GAS_APPROVE = 120_000n;
const GAS_SWAP = 700_000n;

// The environment is moving the price on purpose; the bound is only against a pathological fill.
const WAVE_SLIPPAGE_BPS = 1_500n;
// Buy deltas below this fraction of one block's buy are rounding, not schedule. (It was of the
// wave's total, which for a wave longer than 100 blocks -- a memoryless one can be -- is more than a
// block's buy, so the wave would have bought every other block.) Sell-back deltas: of the tokens held
// when the decay began.
const MIN_DELTA_BPS = 100n;
// Blocks to wait for a submitted transaction before treating it as lost.
const PENDING_TIMEOUT_BLOCKS = 3;
// How many times a listing that reverted is retried before the launch is given up on.
const LIST_ATTEMPTS = 3;

export const LAUNCH_WALLET_PREFIX = "launch";
export const LAUNCH_WAVE_WALLET_PREFIX = "launch-wave";

// The launch wallets are slots, created and funded in every run whether or not the schedule lists a
// token (rules §3.3). They used to be one pair per drawn token, each holding exactly its draw, which
// told an agent at block 0 that this was `launch`, how many tokens would list, which were duds and
// how big each wave was: the wallets' setup approvals are transactions in the setup blocks, and the
// balances are readable by address in every later epoch of the same matrix process. Three slots is
// config/regimes/launch.yaml's ceiling; test/regimeStartInvariance.test.ts holds every official
// regime under it, and a schedule that draws more refuses to start (launchWalletFunding).
export const LAUNCH_WALLET_SLOTS = 3;
// Each slot's USDC, whatever it lists: the largest pool and the largest wave config/regimes/launch.yaml
// can draw. The listing seeds exactly its drawn `liquidityUsdc` and the wave buys toward its drawn
// total, so a wallet holding more changes nothing it does. The pool side is 100k. The wave's is its
// longest possible run: a memoryless wave (waveStopProb) buys the drawn multiple over the *mean*
// length per block, so one that runs to the cap spends cap / mean times that -- 75 / 23.8 = 3.15x a
// 1.0x wave on a 100k pool, ~315k (it was 100k when every wave bought exactly its multiple). The
// largest of these push the pool past WAVE_PRICE_CAP_MULT before they are done, and the cap stops them.
export const LAUNCH_WALLET_USDC_UNITS = 100_000n * 10n ** BigInt(TOKENS.USDC.decimals);
export const LAUNCH_WAVE_USDC_UNITS = 320_000n * 10n ** BigInt(TOKENS.USDC.decimals);

export function launchWalletKey(slot: number): string {
  return `${LAUNCH_WALLET_PREFIX}:${slot}`;
}
export function launchWaveWalletKey(slot: number): string {
  return `${LAUNCH_WAVE_WALLET_PREFIX}:${slot}`;
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
  // The wallet slot this launch trades from (launchWalletKey / launchWaveWalletKey).
  slot: number;
  event: ResolvedStressEvent;
  launch: ResolvedTokenLaunch;
  launchWallet: LaunchWallet;
  waveWallet: LaunchWallet;
  liquidityUsdcUnits: bigint;
  tokenSupplyWei: bigint;
  waveUsdcUnits: bigint;
  // One block's buy, for a wave with a per-block size (waveStopProb). Undefined for a fixed ramp.
  waveBlockUsdcUnits?: bigint;
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
  // Set when the wave found the pool above WAVE_PRICE_CAP_MULT: the ramp blocks it had bought by
  // then. The cap ends the wave for good, the way a drawn stop does (waveTargets).
  capStoppedAfter?: number;
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
  launcher: Address;
  seed: number;
};

/**
 * The CREATE2 salt of a listing. From the environment's wallet secret (walletKeys.ts), not the scenario
 * key: the scenario key is public for the public scenario set and published after the results, and a
 * salt anyone can compute is a token address anyone can pre-create a pool for. The launcher refuses a
 * pre-created pool, so a known salt would cost a griefed listing rather than the wave's USDC -- but
 * the attempt number is in the salt too, so even a retry lands somewhere nobody could predict.
 * Never passed to an agent.
 */
export function launchSalt(
  seed: number,
  eventIndex: number,
  index: number,
  attempt: number,
): Hex {
  return environmentKey("launch-salt", `${seed}:${eventIndex}:${index}:${attempt}`);
}

/** The launch token's constructor arguments, shared by the CREATE2 prediction and the call. */
export function launchTokenArgs(state: {
  eventIndex: number;
  index: number;
  symbol: string;
  tokenSupplyWei: bigint;
}): readonly [string, string, number, bigint] {
  return [
    `Launch Token ${state.eventIndex}-${state.index}`,
    state.symbol,
    LAUNCH_TOKEN_DECIMALS,
    state.tokenSupplyWei,
  ];
}

/** Where the launcher's CREATE2 puts the token. */
export function predictLaunchToken(
  launcher: Address,
  salt: Hex,
  initCode: Hex,
): Address {
  return getContractAddress({ opcode: "CREATE2", from: launcher, salt, bytecode: initCode });
}

/** USDC per whole launch token at a pool's sqrtPriceX96. */
export function launchPriceUsdcPerToken(
  sqrtPriceX96: bigint,
  tokenIsToken0: boolean,
): number {
  // token1 per token0 in raw units, then to human units by the decimals gap.
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const gap = LAUNCH_TOKEN_DECIMALS - TOKENS.USDC.decimals;
  return tokenIsToken0 ? raw * 10 ** gap : 1 / (raw * 10 ** -gap);
}

/** True when the wave should refuse to buy at this price. */
export function waveBuyCapped(priceUsdcPerToken: number): boolean {
  return !(priceUsdcPerToken <= WAVE_PRICE_CAP_MULT * LAUNCH_LISTING_PRICE_USDC);
}

/** Whether this run deploys the token launcher: wherever there is a registry and a Uniswap venue.
 *  A function of the deployment, not of the schedule -- a launcher only in `launch` would name it. */
export function tokenLauncherEnabled(opts: {
  agentMarkets: boolean;
  uniswapEnabled: boolean;
}): boolean {
  return opts.agentMarkets && opts.uniswapEnabled;
}

/// Every launch wallet slot approves the launcher for USDC, in every run that has one. The launcher
/// pulls only from its caller and only the launch wallets can call it.
export async function grantLauncherApprovals(
  ctx: SimContext,
  launcher: Address,
  launchWalletKeys: Hex[],
): Promise<void> {
  for (const pk of launchWalletKeys)
    await sendBatch(ctx.publicClient, ctx.walletClient, ctx.chain, pk, [
      { to: TOKENS.USDC.address, data: approveData(launcher, maxUint256) },
    ]);
}

// USDC units per whole dollar.
const USDC_UNIT = 10n ** BigInt(TOKENS.USDC.decimals);

/// What every launch of the schedule needs, and the wallet slot it trades from (the k-th launch of
/// `schedule.tokenLaunches()` is slot k). Pure: the coordinator funds from launchWalletFunding, which
/// reads this, and the tests read both.
export function tokenLaunchEndowments(schedule: EventSchedule): Array<{
  eventIndex: number;
  index: number;
  slot: number;
  launchKey: string;
  waveKey: string;
  liquidityUsdcUnits: bigint;
  waveUsdcUnits: bigint;
}> {
  return schedule.tokenLaunches().map(({ eventIndex, launch }, slot) => {
    const liquidityUsdcUnits = BigInt(launch.liquidityUsdc) * USDC_UNIT;
    return {
      eventIndex,
      index: launch.index,
      slot,
      launchKey: launchWalletKey(slot),
      waveKey: launchWaveWalletKey(slot),
      liquidityUsdcUnits,
      waveUsdcUnits: waveUsdcUnits(launch),
    };
  });
}

/// What each launch slot is funded with: the fixed amounts, raised only where a draw needs more (an
/// official regime never does; the test holds its ceiling under them). Every slot is listed, used or
/// not, so a run without launches funds exactly what a run with three does.
export function launchWalletFunding(schedule: EventSchedule): Array<{
  slot: number;
  launchKey: string;
  waveKey: string;
  launchUsdcUnits: bigint;
  waveUsdcUnits: bigint;
}> {
  const needs = tokenLaunchEndowments(schedule);
  if (needs.length > LAUNCH_WALLET_SLOTS)
    throw new Error(
      `the schedule lists ${needs.length} tokens, but the environment has ${LAUNCH_WALLET_SLOTS} launch ` +
        "wallet slots. Raise LAUNCH_WALLET_SLOTS (core/src/realtime/tokenLaunch.ts) for every regime " +
        "at once: a slot count that follows the schedule names the regime at block 0",
    );
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  return Array.from({ length: LAUNCH_WALLET_SLOTS }, (_, slot) => {
    const need = needs[slot];
    return {
      slot,
      launchKey: launchWalletKey(slot),
      waveKey: launchWaveWalletKey(slot),
      launchUsdcUnits: max(LAUNCH_WALLET_USDC_UNITS, need?.liquidityUsdcUnits ?? 0n),
      waveUsdcUnits: max(LAUNCH_WAVE_USDC_UNITS, need?.waveUsdcUnits ?? 0n),
    };
  });
}

/// The most any seed can draw under these configs: the token count, and the largest pool and wave
/// a single token can have. Pure, for the test that holds official regimes under the fixed amounts.
export function tokenLaunchCeiling(configs: StressEventConfig[]): {
  tokens: number;
  liquidityUsdcUnits: bigint;
  waveUsdcUnits: bigint;
} {
  let tokens = 0;
  let liquidityUsdcUnits = 0n;
  let waveMax = 0n;
  for (const c of configs) {
    if (c.type !== "tokenLaunch") continue;
    tokens += (c.count ? c.count[1] : 1) * (c.tokenCount ? c.tokenCount[1] : 1);
    const liquidity = Math.round(c.liquidityUsdc ? c.liquidityUsdc[1] : 0);
    const units = BigInt(liquidity) * USDC_UNIT;
    if (units > liquidityUsdcUnits) liquidityUsdcUnits = units;
    // A memoryless wave that runs to its cap spends cap / mean-length times its drawn multiple
    // (events.ts drawWaveLengths); a fixed ramp spends exactly the multiple.
    const cap = Array.isArray(c.rampBlocks) ? c.rampBlocks[1] : c.rampBlocks;
    const mult = c.waveUsdcMult ? c.waveUsdcMult[1] : 0;
    const block =
      c.waveStopProb !== undefined
        ? mult / waveLengthMean(c.waveStopProb, cap)
        : undefined;
    const wave = waveUsdcUnits({
      index: 0,
      liquidityUsdc: liquidity,
      waveUsdcMult: block !== undefined ? block * cap : mult,
      waveBlockUsdcMult: block,
      rampBlocks: block !== undefined ? cap : undefined,
      dud: false,
      sellBackFrac: 0,
    });
    if (wave > waveMax) waveMax = wave;
  }
  return { tokens, liquidityUsdcUnits, waveUsdcUnits: waveMax };
}

// The wave's total USDC, from its multiple of the pool's USDC side. Rounded to whole units on a
// 1e6 grid so two runs of the same scenario endow the same wallet. A wave with a per-block size is
// that block times its length, exactly, so that every buy is a whole number of blocks.
export function waveUsdcUnits(launch: ResolvedTokenLaunch): bigint {
  const block = waveBlockUsdcUnits(launch);
  if (block !== undefined && launch.rampBlocks !== undefined)
    return block * BigInt(launch.rampBlocks);
  if (launch.dud || launch.waveUsdcMult <= 0) return 0n;
  const mult = BigInt(Math.round(launch.waveUsdcMult * 1_000_000));
  return (BigInt(launch.liquidityUsdc) * USDC_UNIT * mult) / 1_000_000n;
}

// One block's buy of a memoryless wave, on the same 1e6 grid, from the per-block multiple alone:
// nothing in it depends on the length. Undefined for a fixed ramp (no per-block size).
export function waveBlockUsdcUnits(
  launch: ResolvedTokenLaunch,
): bigint | undefined {
  if (launch.waveBlockUsdcMult === undefined) return undefined;
  if (launch.dud || launch.waveBlockUsdcMult <= 0) return 0n;
  const mult = BigInt(Math.round(launch.waveBlockUsdcMult * 1_000_000));
  return (BigInt(launch.liquidityUsdc) * USDC_UNIT * mult) / 1_000_000n;
}

// The USDC the wave should have spent by this block. A per-block wave is an integer number of
// blocks' worth; a fixed ramp a fraction of its total, as before the stop existed.
export function waveBuyTargetUnits(
  state: Pick<TokenLaunchState, "waveUsdcUnits" | "waveBlockUsdcUnits">,
  target: Pick<TokenLaunchTarget, "buyFrac" | "buyBlocks">,
): bigint {
  if (state.waveBlockUsdcUnits !== undefined)
    return state.waveBlockUsdcUnits * BigInt(target.buyBlocks);
  return scaleUnits(state.waveUsdcUnits, target.buyFrac);
}

// The ramp a wave that finds the pool above the cap at this block is cut to: the blocks before this
// one, never more than its own length (a wave catching up on missed buys after its ramp keeps its
// scheduled sell-back).
export function capStopRamp(
  state: Pick<TokenLaunchState, "launch" | "event">,
  target: Pick<TokenLaunchTarget, "rampIndex">,
): number {
  return Math.max(0, Math.min(rampOf(state), target.rampIndex));
}

// What the driver reconciles toward this block. The schedule's targets, until the price cap stops
// the wave: then nothing more to buy, and the sell-back runs from the stop -- the same hold and
// decay as a drawn stop at that block.
export function waveTargets(
  state: Pick<
    TokenLaunchState,
    | "launch"
    | "event"
    | "waveUsdcUnits"
    | "waveBlockUsdcUnits"
    | "grossBuyUsdc"
    | "capStoppedAfter"
  >,
  target: Pick<
    TokenLaunchTarget,
    "buyFrac" | "buyBlocks" | "rampIndex" | "sellBackFrac"
  >,
): { buyTarget: bigint; sellBackFrac: number } {
  if (state.capStoppedAfter === undefined)
    return {
      buyTarget: waveBuyTargetUnits(state, target),
      sellBackFrac: target.sellBackFrac,
    };
  return {
    buyTarget: state.grossBuyUsdc,
    sellBackFrac: launchSellBackFrac(
      state.launch,
      target.rampIndex,
      state.capStoppedAfter,
      state.event.holdBlocks,
      state.event.decayBlocks,
    ),
  };
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
    // The TokenLauncher the registry setup deployed (MarketRegistryRuntime.tokenLauncher).
    tokenLauncher: Address | undefined;
    seed: number;
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
  if (!opts.tokenLauncher)
    throw new Error(
      "stress event tokenLaunch: no TokenLauncher was deployed (it goes up with the market registry " +
        "wherever there is a Uniswap factory). Is `npm run build:contracts` current?",
    );
  // The artifacts are read once here so a missing build fails at setup, not on the window's block.
  readForgeArtifact("AgentERC20");
  readForgeArtifact("TokenLauncher");
  const launches: TokenLaunchState[] = schedule
    .tokenLaunches()
    .map(({ eventIndex, event, launch }, slot) => {
      const liquidityUsdcUnits = BigInt(launch.liquidityUsdc) * USDC_UNIT;
      return {
        eventIndex,
        index: launch.index,
        event,
        launch,
        slot,
        launchWallet: opts.walletByKey(launchWalletKey(slot)),
        waveWallet: opts.walletByKey(launchWaveWalletKey(slot)),
        liquidityUsdcUnits,
        tokenSupplyWei:
          BigInt(launch.liquidityUsdc) * 10n ** BigInt(LAUNCH_TOKEN_DECIMALS),
        waveUsdcUnits: waveUsdcUnits(launch),
        waveBlockUsdcUnits: waveBlockUsdcUnits(launch),
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
  // The approval is granted at setup in every run (grantLauncherApprovals); staging only checks it.
  for (const l of launches)
    await requireStandingApprovals(
      ctx,
      l.launchWallet.address,
      [{ token: TOKENS.USDC.address, spender: opts.tokenLauncher }],
      "tokenLaunch",
    );
  logger.event({
    type: "stress_token_launch_setup",
    factory,
    launcher: opts.tokenLauncher,
    fee: LAUNCH_POOL_FEE,
    waveCapMult: WAVE_PRICE_CAP_MULT,
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
  return {
    launches,
    usdc: TOKENS.USDC.address,
    factory,
    launcher: opts.tokenLauncher,
    seed: opts.seed,
  };
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
  opts: { priorityFeeWei: bigint; bid?: EnvBidContext },
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
      const { buyTarget, sellBackFrac } = waveTargets(state, target);
      const buyDelta =
        buyTarget > state.grossBuyUsdc ? buyTarget - state.grossBuyUsdc : 0n;
      const minDelta =
        state.waveBlockUsdcUnits !== undefined
          ? (state.waveBlockUsdcUnits * MIN_DELTA_BPS) / 10_000n
          : (state.waveUsdcUnits * MIN_DELTA_BPS) /
            10_000n /
            BigInt(Math.max(1, rampOf(state)));
      if (buyDelta > 0n && buyDelta >= minDelta) {
        const amountIn = buyDelta > usdcNow ? usdcNow : buyDelta;
        const price = await poolPrice(ctx, runtime, state);
        if (amountIn > 0n && waveBuyCapped(price)) {
          // The wave stops here for good, as if its stop had been drawn at this block: what it has
          // not bought is dropped and its hold and sell-back run from here. It used to wait out the
          // cap with the unbought target accumulating, which kept it from ever reaching the
          // sell-back while the price stayed up, and the first block back under the cap bought the
          // whole backlog in one swap (up to 73 blocks' worth) -- a release any holder could time by
          // selling the pool just under the cap, and then sell into.
          state.capStoppedAfter = capStopRamp(state, target);
          logger.event({
            type: "stress_token_launch_wave_capped",
            eventIndex: state.eventIndex,
            index: state.index,
            symbol: state.symbol,
            blockIndex,
            blockNumber,
            pool: state.pool,
            priceUsdcPerToken: price,
            capUsdcPerToken: WAVE_PRICE_CAP_MULT * LAUNCH_LISTING_PRICE_USDC,
            stoppedAfterBlocks: state.capStoppedAfter,
            unboughtUsdcUnits: (state.waveUsdcUnits > state.grossBuyUsdc
              ? state.waveUsdcUnits - state.grossBuyUsdc
              : 0n
            ).toString(),
          });
          continue;
        }
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
      if (sellBackFrac > 0 && state.token) {
        const held = await balanceOf(
          ctx,
          state.token,
          state.waveWallet.address,
        );
        if (state.heldAtDecayStart === undefined) state.heldAtDecayStart = held;
        const sellTarget = scaleUnits(
          state.heldAtDecayStart,
          sellBackFrac,
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
      // The blocks the schedule had this wave buy for (memoryless under waveStopProb).
      rampBlocks: rampOf(state),
      // The ramp blocks it bought before the price cap stopped it; null = it ran its length.
      capStoppedAfterBlocks: state.capStoppedAfter ?? null,
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
  opts: { priorityFeeWei: bigint; bid?: EnvBidContext },
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
      // The launcher reverts as a whole, so nothing was listed. The likeliest named cause is a pool
      // somebody created first for the predicted address (PoolAlreadyExists) -- which needs the salt,
      // so it should not happen; reported so it is visible if it does. The retry uses a new salt.
      let preempted = false;
      if (state.token) {
        const existing = (await ctx.publicClient.readContract({
          address: runtime.factory,
          abi: uniswapV3FactoryAbi,
          functionName: "getPool",
          args: [state.token, runtime.usdc, LAUNCH_POOL_FEE],
        })) as Address;
        preempted = existing !== ZERO;
      }
      logger.event({
        type: "stress_token_launch_failed",
        eventIndex: state.eventIndex,
        index: state.index,
        symbol: state.symbol,
        blockIndex,
        blockNumber,
        attempt: state.listAttempts,
        hashes: state.listing.hashes,
        token: state.token ?? null,
        preempted,
        error: preempted
          ? "listing reverted: a pool for the predicted token address already existed"
          : "listing reverted",
      });
      state.token = undefined;
      state.listing = undefined;
      state.phase = state.listAttempts >= LIST_ATTEMPTS ? "failed" : "pending";
    } else {
      // The launcher's own event names what it made; the prediction is only what was signed.
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: last });
      let launched: { token: Address; pool: Address } | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== runtime.launcher.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: tokenLauncherEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as { token: Address; pool: Address };
          launched = { token: args.token, pool: args.pool };
        } catch {
          // not the Launched event
        }
      }
      if (!launched) throw new Error("listing succeeded but the launcher emitted no Launched event");
      state.token = launched.token;
      const pool = launched.pool;
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
      ownerKey: launchWalletKey(state.slot),
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

// One call to the launcher: CREATE2 the token under this attempt's salt, refuse a pool that already
// exists, create and initialize it at 1.00 USDC, and seed the full range from the launch wallet's
// USDC. The position NFT and any rounding dust come back to the launch wallet.
async function sendListingBatch(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
  priorityFeeWei: bigint,
): Promise<Hex[]> {
  const account = privateKeyToAccount(state.launchWallet.privateKey);
  const salt = launchSalt(runtime.seed, state.eventIndex, state.index, state.listAttempts);
  const tokenArtifact = readForgeArtifact("AgentERC20");
  const args = launchTokenArgs(state);
  const initCode = encodeDeployData({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args,
  });
  const token = predictLaunchToken(runtime.launcher, salt, initCode);
  state.token = token;
  const tokenIsToken0 = token.toLowerCase() < runtime.usdc.toLowerCase();
  const sqrtPriceX96 = sqrtPriceX96For({
    humanPrice: LAUNCH_LISTING_PRICE_USDC,
    token0Decimals: tokenIsToken0
      ? LAUNCH_TOKEN_DECIMALS
      : TOKENS.USDC.decimals,
    token1Decimals: tokenIsToken0
      ? TOKENS.USDC.decimals
      : LAUNCH_TOKEN_DECIMALS,
  });
  const { abi } = readForgeArtifact("TokenLauncher");
  const data = encodeFunctionData({
    abi,
    functionName: "launch",
    args: [
      {
        salt,
        name: args[0],
        symbol: args[1],
        decimals: args[2],
        supply: args[3],
        usdcAmount: state.liquidityUsdcUnits,
        expectedToken: token,
        sqrtPriceX96,
      },
    ],
  });
  const nonce = await ctx.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await ctx.walletClient.sendTransaction({
    account,
    chain: ctx.chain,
    to: runtime.launcher,
    data,
    // Pinned: the estimate would run against a state the transaction does not run in.
    gas: GAS_LAUNCH,
    nonce,
    maxFeePerGas: baseFee + priorityFeeWei,
    maxPriorityFeePerGas: priorityFeeWei,
  });
  return [hash];
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
  opts: { priorityFeeWei: bigint; bid?: EnvBidContext },
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
  // Under economicGas the limit is drawn per trade and tight (ADR 0011 §1b): the old 15% let a
  // sandwich around a wave buy take most of its impact.
  const slippageBps = opts.bid
    ? BigInt(opts.bid.bidder.drawSlippageBps(...LAUNCH_WAVE_SLIPPAGE_BPS))
    : WAVE_SLIPPAGE_BPS;
  const minOut = (quoted * (10_000n - slippageBps)) / 10_000n;
  // economicGas (ADR 0011 §1c): an ordinary buyer's fee; the trade is protected by its slippage
  // limit, not by outbidding whoever might get ahead of it. Its impact (V) is recorded, not bid. The
  // approve, when there is one, goes at the same fee: same sender, nonce order.
  let bid: (EnvBid & { valueUsd: number }) | null = null;
  if (opts.bid) {
    const small = probeAmount(amountIn);
    let smallQuoted = 0n;
    try {
      const probe = await ctx.publicClient.simulateContract({
        address: UNISWAP.quoterV2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          { tokenIn, tokenOut, amountIn: small, fee: LAUNCH_POOL_FEE, sqrtPriceLimitX96: 0n },
        ],
      });
      smallQuoted = probe.result[0];
    } catch {
      // No marginal rate: V is 0 and the bid is the floor, which is a price, not a stall.
    }
    bid = {
      ...opts.bid.bidder.flatBid(FLAT_FEE_MEDIAN_WEI),
      valueUsd: impactValueUsd({
        amountIn,
        quoted,
        smallIn: small,
        smallQuoted,
        usdDecimals: TOKENS.USDC.decimals,
        usdSide: kind === "buy" ? "in" : "out",
      }),
    };
  }
  const priorityFeeWei = bid?.priorityFeeWei ?? opts.priorityFeeWei;
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
      maxFeePerGas: baseFee + priorityFeeWei,
      maxPriorityFeePerGas: priorityFeeWei,
    });
  const ownerKey = launchWaveWalletKey(state.slot);
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
    ...(bid
      ? {
          priorityFeeWei: bid.priorityFeeWei.toString(),
          frontRunValueUsd: Number(bid.valueUsd.toFixed(4)),
        }
      : {}),
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

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// The blocks this token's wave buys for: its own memoryless length, or the window's ramp.
function rampOf(state: Pick<TokenLaunchState, "launch" | "event">): number {
  return state.launch.rampBlocks ?? state.event.rampBlocks;
}

async function poolPrice(
  ctx: SimContext,
  runtime: TokenLaunchRuntime,
  state: TokenLaunchState,
): Promise<number> {
  const slot0 = (await ctx.publicClient.readContract({
    address: state.pool as Address,
    abi: poolAbi,
    functionName: "slot0",
  })) as readonly [bigint, ...unknown[]];
  const tokenIsToken0 =
    (state.token as Address).toLowerCase() < runtime.usdc.toLowerCase();
  return launchPriceUsdcPerToken(slot0[0], tokenIsToken0);
}

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
