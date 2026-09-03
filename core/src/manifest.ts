// The environment manifest (ADR 0021 §2).
//
// A participant on the practice devnet runs their agent on their own machine. Nothing hands them a
// coordinator's env any more -- no ERIS_RUN_DIR, no injected PriceFeed address, no roster spawn. So
// everything the runtime used to receive over that channel has to be publishable instead, and this
// is that document: where the chain is, what is deployed on it, what a round is, what the limits
// are, and which addresses are competing.
//
// Two rules shape what goes in it.
//
//   Nothing secret. The coordinator writes this into the run directory, and the dashboard serves
//   that directory over HTTP. A private key in here is a published private key. Keys are handed out
//   one participant at a time, on stdout, by `npm run manifest -- --participant <id>`.
//
//   No stress timings. ADR 0021 §1 publishes the *kinds* of episode a period contains and how many,
//   and withholds when they open. The schedule object the coordinator holds has resolved windows in
//   it, so this file takes the type and the count and never the blocks -- the disclosure is built
//   from the config's event list rather than from the resolved schedule, so a future field on the
//   schedule cannot leak into it by accident.
import {
  AAVE,
  BALANCER,
  CURVE,
  GMX,
  GMX_MARKETS,
  LIQUITY,
  LST,
  MULTICALL3,
  STABLE_MARKET_LEGS,
  TOKENS,
  UNISWAP,
} from "@eris/sdk/constants.js";
import { ACTION_TYPES_BY_PROTOCOL } from "@eris/sdk/action.js";
import { baseTokens, stableTokens } from "@eris/sdk/markets.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import type { RealtimeConfig } from "./config.js";

export const MANIFEST_SCHEMA = "eris-environment-manifest/1";
export const MANIFEST_FILENAME = "manifest.json";

export type ManifestParticipant = {
  id: string;
  address: string;
  /** True when the participant runs the agent themselves (ADR 0021 §2). */
  external: boolean;
  /** ADR 0019 §2's benchmark entry, whose returns every score is measured as excess over. */
  baseline: boolean;
  description?: string;
};

export type EnvironmentManifest = {
  schema: typeof MANIFEST_SCHEMA;
  generatedAt: string;
  /**
   * ADR 0021 §1. Stated in the document itself rather than only on the standings page, because the
   * manifest is what gets copied into READMEs and chat messages, and a ranking whose provenance
   * travels separately from the ranking is a ranking that will be misread.
   */
  status: {
    scored: false;
    label: "practice";
    note: string;
  };
  chain: {
    rpcUrl: string;
    readRpcUrl: string;
    chainId: number;
    chainMode: string;
    blockTimeSec: number;
  };
  round: {
    epochBlocks: number;
    approxSeconds: number;
    markMedianBlocks: number;
    scoreEvery: number;
    note: string;
  };
  protocols: ProtocolId[];
  actions: Partial<Record<ProtocolId, readonly string[]>>;
  contracts: Record<string, unknown>;
  tokens: Record<string, { address: string; decimals: number; kind: string }>;
  limits: Record<string, string | number>;
  funding: Record<string, string>;
  /** Types and counts only -- never windows. See the header. */
  episodes: { kinds: Array<{ type: string; count: number }>; note: string };
  participants: ManifestParticipant[];
};

// Only the venues this run turned on. A participant reading an address for a venue that is not
// enabled would build against something the environment will not price or accept actions for.
function contractsFor(protocols: ProtocolId[]): Record<string, unknown> {
  const out: Record<string, unknown> = { multicall3: MULTICALL3 };
  if (protocols.includes("uniswap")) out.uniswap = UNISWAP;
  if (protocols.includes("balancer")) out.balancer = BALANCER;
  if (protocols.includes("curve")) out.curve = CURVE;
  if (protocols.includes("gmx")) out.gmx = { ...GMX, markets: GMX_MARKETS };
  if (protocols.includes("aave")) out.aave = AAVE;
  if (protocols.includes("lst") && LST) out.lst = LST;
  if (protocols.includes("liquity") && LIQUITY) out.liquity = LIQUITY;
  // Which pool quotes each market-priced stable. Without it a participant can see that a stable is
  // off par and have nowhere to act on it -- the same gap `stableSwap` was added to close (#27).
  const legs = Object.entries(STABLE_MARKET_LEGS).filter(([, leg]) =>
    protocols.includes(leg.venue as ProtocolId),
  );
  if (legs.length > 0) out.stableMarkets = Object.fromEntries(legs);
  return out;
}

export function buildManifest(opts: {
  config: RealtimeConfig;
  participants: ManifestParticipant[];
  /** Deployed at setup, so it is only known once a run has started. */
  priceFeed?: string;
}): EnvironmentManifest {
  const { config, participants } = opts;
  const protocols = config.enabledProtocols;
  const contracts = contractsFor(protocols);
  if (opts.priceFeed) contracts.priceFeed = opts.priceFeed;

  const tokens: EnvironmentManifest["tokens"] = {};
  for (const t of baseTokens())
    tokens[t.symbol] = {
      address: t.address,
      decimals: t.decimals,
      kind: "base",
    };
  for (const t of stableTokens())
    tokens[t.symbol] = {
      address: t.address,
      decimals: t.decimals,
      kind: "stable",
    };

  // Counted by type. A period that contains four crashes says so; when the four open is the thing
  // being withheld (ADR 0021 §1).
  const kinds = new Map<string, number>();
  for (const ev of config.stressEvents)
    kinds.set(ev.type, (kinds.get(ev.type) ?? 0) + 1);

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: {
      scored: false,
      label: "practice",
      note:
        "Standings on this chain are practice standings. The competition is scored separately, " +
        "from submitted bundles replayed over a scenario matrix (ADR 0017 / ADR 0020), and " +
        "nothing here feeds into it.",
    },
    chain: {
      rpcUrl: config.rpcUrl,
      readRpcUrl: config.readRpcUrl,
      chainId: config.chainId,
      chainMode: config.chainMode,
      blockTimeSec: config.blockTimeSec,
    },
    round: {
      epochBlocks: config.epochBlocks,
      // Real time is the unit ADR 0021 §3 states a round in; blocks are what that comes to at this
      // chain's cadence. Both are published, because a participant sizing an exit against
      // `blocksRemaining` needs the blocks and a participant deciding when to check the standings
      // needs the minutes.
      approxSeconds: config.epochBlocks * config.blockTimeSec,
      markMedianBlocks: config.markMedianBlocks,
      scoreEvery: config.scoreEvery,
      note:
        "A round is the scoring epoch (ADR 0019): scores, rank moves and environment episodes are " +
        "all read against it.",
    },
    protocols,
    actions: Object.fromEntries(
      protocols.map((id) => [id, ACTION_TYPES_BY_PROTOCOL[id]]),
    ),
    contracts,
    tokens,
    // Order size is not among them. The competition has no per-order cap on any venue -- not a
    // raised one, none -- so a trade is bounded by the wallet behind it and by what the pool will
    // give up. Stated rather than omitted: a participant who finds no cap in the manifest should
    // not have to guess whether that means "unlimited" or "not published".
    limits: {
      orderSize: "none",
      note:
        "No per-order size cap, no bundle-length cap and no open-position cap on any venue. A " +
        "trade is bounded by your balance and by the depth you are trading into.",
      defaultPriorityFeeWei: config.defaultPriorityFeeWei.toString(),
      maxPriorityFeeWei: config.maxPriorityFeeWei.toString(),
    },
    funding: {
      ethWei: config.initialEthWei.toString(),
      wethWei: config.initialWethWei.toString(),
      usdcUnits: config.initialUsdcUnits.toString(),
    },
    episodes: {
      kinds: [...kinds].map(([type, count]) => ({ type, count })),
      note:
        "Kinds and counts are published; when each window opens is not (ADR 0021 §1). Read the " +
        "chain, not this list, to know whether one is open now.",
    },
    participants,
  };
}
