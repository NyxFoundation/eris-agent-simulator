// RPC read-path capacity, in Eris's own shape (issue #36).
//
//   npm run stress:rpc -- [--agents N] [--seconds S] [--concurrency C] [--write] [--depth D]
//
// Why the read path and not throughput: every capacity incident in this project has been on reads.
// Fork runs were bottlenecked by ~270ms cold-state round trips, and a 36-agent roster's per-block
// observe barrage overloaded and crashed a single anvil. Writes have never been the thing that
// broke. So before committing to an OP Stack target (#35), the question is how much read load one
// node sustains, and whether that load disturbs the sequencer.
//
// The load is shaped like an observation rather than like a benchmark: one Multicall3 per agent per
// block, holding the same reads reconstruct.ts issues (native balance, every base and stable
// balance, the PriceFeed answer). A generic eth_call benchmark would measure the node; this measures
// the node under the traffic Eris actually generates, which is the number #36 needs.
//
// Four measurements, matching the issue:
//   1. pure read capacity     -- QPS and p50/p95/p99 at a given concurrency, cold vs warm
//   2. read/write interference -- block-interval jitter with the read load on and off
//   3. historical reads       -- how far back eth_call still answers, and what it costs there
//   4. an architecture verdict -- sequencer-only, or sequencer plus a read replica
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountAddress,
  activeStables,
  fundWallet,
  makeClients,
  setChainMode,
} from "@eris/sdk/chain.js";
import { erc20Abi } from "@eris/sdk/abis.js";
import { MULTICALL3 } from "@eris/sdk/constants.js";
import { baseTokens } from "@eris/sdk/markets.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import { parseCliFlags, resolveRunInputs } from "./runConfig.js";

const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
]);
const priceFeedAbi = parseAbi([
  "function latestAnswer() view returns (int256)",
]);

type Sample = { ms: number; ok: boolean };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function stats(samples: Sample[]) {
  const ok = samples
    .filter((s) => s.ok)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: samples.filter((s) => !s.ok).length,
    p50: Math.round(percentile(ok, 50)),
    p95: Math.round(percentile(ok, 95)),
    p99: Math.round(percentile(ok, 99)),
    max: Math.round(ok[ok.length - 1] ?? 0),
  };
}

const flags = parseCliFlags(process.argv);
const agents = Math.max(1, Number(flags.agents ?? 24));
const seconds = Math.max(2, Number(flags.seconds ?? 20));
const concurrency = Math.max(1, Number(flags.concurrency ?? agents));
const depthProbe = Math.max(0, Number(flags.depth ?? 2000));
const withWrites = Boolean(flags.write);

const { config } = resolveRunInputs(process.argv);
setChainMode(config.chainMode, config.treasuryPrivateKey);
initProtocols(config.enabledProtocols);
const readUrl = flags.rpc ?? config.readRpcUrl;
const { chain, publicClient, walletClient } = makeClients(
  readUrl,
  config.chainId,
);
// Writes always go to the sequencer, even when reads are aimed at a replica: that split is the
// architecture under test, and sending both to the same place would measure the wrong thing.
const writeClients = makeClients(config.rpcUrl, config.chainId);

// The addresses being read are synthetic. Balance reads cost the node the same whether the account
// holds anything, and inventing them keeps the tool runnable against a chain with no run on it.
const probeAgents: Address[] = Array.from({ length: agents }, (_, i) =>
  accountAddress(keccak256(stringToBytes(`rpc-stress:${i}`))),
);

const tokens: Address[] = [
  ...baseTokens().map((t) => t.address),
  ...activeStables(),
];
const priceFeed = flags["price-feed"] as Address | undefined;

// One agent's observation: the same read set reconstruct.ts batches per cross-section.
function observationCalls(agent: Address) {
  const calls = [
    {
      target: MULTICALL3,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: multicall3Abi,
        functionName: "getEthBalance",
        args: [agent],
      }),
    },
    ...tokens.map((token) => ({
      target: token,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent],
      }),
    })),
  ];
  if (priceFeed)
    calls.push({
      target: priceFeed,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: priceFeedAbi,
        functionName: "latestAnswer",
      }),
    });
  return calls;
}

const READS_PER_OBSERVATION = observationCalls(probeAgents[0]).length;

async function observe(
  client: PublicClient,
  agent: Address,
  blockNumber?: bigint,
): Promise<Sample> {
  const started = Date.now();
  try {
    await client.readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [observationCalls(agent)],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return { ms: Date.now() - started, ok: true };
  } catch {
    return { ms: Date.now() - started, ok: false };
  }
}

// ---------------------------------------------------------------------------
// 1. pure read capacity

async function readCapacity(): Promise<{
  samples: Sample[];
  cold: ReturnType<typeof stats>;
  warm: ReturnType<typeof stats>;
  elapsedMs: number;
}> {
  const samples: Sample[] = [];
  const deadline = Date.now() + seconds * 1000;
  const started = Date.now();
  let next = 0;
  // A fixed number of requests in flight, refilled as each returns. Matches how the environment
  // behaves under load -- N agents each with one observation outstanding -- rather than firing an
  // unbounded burst, which measures the client's queue instead of the node.
  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const agent = probeAgents[next++ % probeAgents.length];
      samples.push(await observe(publicClient, agent));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = Date.now() - started;
  // The first pass over the agent set touches state the node has not served yet. On a fork that gap
  // was the whole bottleneck (~270ms per cold read), so the two are reported apart rather than
  // averaged into a number that describes neither.
  const boundary = Math.min(samples.length, probeAgents.length);
  return {
    samples,
    cold: stats(samples.slice(0, boundary)),
    warm: stats(samples.slice(boundary)),
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// 2. read/write interference

// Block intervals over a window, in ms, taken from the blocks' own timestamps. Jitter -- not the
// mean -- is the signal: a sequencer that also answers reads is at risk of *stalling*, and a stall
// shows up as one long interval among otherwise regular ones.
//
// Read afterwards rather than polled live, and this is not a detail. The first version polled
// eth_blockNumber in the same process as the read load, and under load the poller itself fell
// behind: it saw two-block jumps, split each into two half-length intervals, and reported that
// blocks came *faster* under load than idle. The chain already records when each block was built,
// so the honest measurement is to ask it.
type BlockWindow = { intervalsMs: number[]; blocks: number };

async function watchBlockWindow(windowMs: number): Promise<BlockWindow> {
  const client = writeClients.publicClient;
  const first = Number(await client.getBlockNumber());
  await new Promise((r) => setTimeout(r, windowMs));
  const last = Number(await client.getBlockNumber());
  if (last <= first) return { intervalsMs: [], blocks: 0 };
  const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const blocks = await Promise.all(
    numbers.map((n) => client.getBlock({ blockNumber: BigInt(n) })),
  );
  const intervalsMs: number[] = [];
  for (let i = 1; i < blocks.length; i++)
    intervalsMs.push(
      Number(blocks[i].timestamp - blocks[i - 1].timestamp) * 1000,
    );
  return { intervalsMs, blocks: intervalsMs.length };
}

function jitter(intervalsMs: number[]) {
  if (intervalsMs.length === 0) return { meanMs: 0, sdMs: 0, maxMs: 0 };
  const mean = intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length;
  const variance =
    intervalsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / intervalsMs.length;
  return {
    meanMs: Math.round(mean),
    sdMs: Math.round(Math.sqrt(variance)),
    maxMs: Math.round(Math.max(...intervalsMs)),
  };
}

// A steady tx stream at roughly the rate a run produces: oracle writes, the keeper, the flow bot and
// the agents. Self-transfers, because what is being measured is inclusion pressure, not execution.
async function writeLoad(
  deadline: number,
  key: Hex,
): Promise<{ sent: number; lastError?: string }> {
  const account = privateKeyToAccount(key);
  let sent = 0;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const block = await writeClients.publicClient.getBlock();
      await writeClients.walletClient.sendTransaction({
        account,
        chain: writeClients.chain,
        to: account.address,
        value: 0n,
        gas: 21_000n,
        maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      sent++;
    } catch (err) {
      // A rejected send is itself load, so the loop keeps going -- but the reason is kept, because a
      // stream that sent nothing means the interference half of this report measured nothing, and
      // the caller turns that into a failure rather than a zero.
      lastError =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { sent, lastError };
}

// ---------------------------------------------------------------------------
// 3. historical reads

// How far back the node still answers an eth_call, and what it costs there. Scoring used to depend
// on this entirely (post-run reconstruction walks the whole window); ADR 0021 §3 moves scoring to
// live cross-sections precisely because the depth is finite -- but the dashboard and any re-scoring
// still read history, so the number stays worth knowing.
async function historicalDepth(): Promise<{
  head: number;
  deepestOk: number | null;
  probes: Array<{ depth: number; ok: boolean; ms: number }>;
}> {
  const head = Number(await publicClient.getBlockNumber());
  const probes: Array<{ depth: number; ok: boolean; ms: number }> = [];
  let deepestOk: number | null = null;
  // Geometric rather than linear: the interesting quantity is an order of magnitude (anvil's ~1,050
  // vs an archive node's everything), and a linear walk to 100k blocks is its own load test.
  for (let depth = 1; depth <= depthProbe; depth = Math.max(depth * 4, 4)) {
    if (depth > head) break;
    const sample = await observe(
      publicClient,
      probeAgents[0],
      BigInt(head - depth),
    );
    probes.push({ depth, ok: sample.ok, ms: sample.ms });
    if (sample.ok) deepestOk = depth;
    else break; // once it stops answering it does not start again deeper
  }
  return { head, deepestOk, probes };
}

// ---------------------------------------------------------------------------

// A capacity number measured from reads that all failed is not a small capacity, it is no
// measurement at all -- and it reads as an enormous one, because a node rejects a call to an empty
// address faster than it serves a real balance. The first version of this tool reported 3,360
// observations/s and a verdict of "sequencer-only is sufficient" against a bare anvil with no
// Multicall3 deployed. So the target is checked before anything is timed.
async function preflight(): Promise<void> {
  const missing: string[] = [];
  const code = await publicClient.getCode({ address: MULTICALL3 });
  if (!code || code === "0x") missing.push(`Multicall3 (${MULTICALL3})`);
  for (const token of tokens) {
    const c = await publicClient.getCode({ address: token });
    if (!c || c === "0x") missing.push(`token ${token}`);
  }
  if (priceFeed) {
    const c = await publicClient.getCode({ address: priceFeed });
    if (!c || c === "0x") missing.push(`PriceFeed ${priceFeed}`);
  }
  if (missing.length === 0) return;
  throw new Error(
    `nothing to read at ${readUrl}: no contract at ${missing.join(", ")}.\n` +
      "The load is shaped like an observation, so it needs the deployment an observation reads. " +
      "Point --rpc at the chain the venues are deployed on (with the address overlay that names " +
      "them: run.localDeploy), or the numbers describe a node saying 'no such account' very fast.",
  );
}

// Reads that error were not served. Above a small floor this is not a capacity measurement of
// anything, and reporting it as one is the failure preflight exists to prevent.
const MAX_ERROR_RATE = 0.01;

async function main(): Promise<void> {
  console.error(
    `[rpc-stress] reads -> ${readUrl}` +
      (config.readRpcUrl !== config.rpcUrl
        ? ` (writes -> ${config.rpcUrl})`
        : "") +
      `\n[rpc-stress] ${agents} agents x ${READS_PER_OBSERVATION} reads/observation, ` +
      `concurrency ${concurrency}, ${seconds}s` +
      (withWrites ? ", with a concurrent tx stream" : ""),
  );
  await preflight();

  // Long enough to hold several blocks whatever the cadence. A window that catches one transition
  // reports a jitter of zero over a sample of one, which is worse than reporting nothing.
  const writerKey = keccak256(stringToBytes("rpc-stress-writer"));
  if (withWrites) {
    // Through the run's own funding path, so this works in both chain modes. Without it every send
    // reverts on balance and the tx stream is a stream of nothing -- which the first version of this
    // tool reported as `writesSent: 0` beside an interference verdict computed as if it had run.
    await fundWallet(
      publicClient,
      writeClients.walletClient,
      writeClients.chain,
      writerKey,
      1_000_000_000_000_000_000n,
      0n,
      0n,
      undefined,
      0n,
    );
  }

  // Idle first, so "under load" has something to be compared against. Long enough to hold several
  // blocks whatever the cadence.
  const baseline = await watchBlockWindow(
    Math.max(6, config.blockTimeSec * 4) * 1000,
  );

  const deadline = Date.now() + seconds * 1000;
  const writer = withWrites
    ? writeLoad(deadline, writerKey)
    : Promise.resolve({ sent: 0, lastError: undefined });
  const intervalsUnderLoad = watchBlockWindow(seconds * 1000);
  const capacity = await readCapacity();
  const loaded = await intervalsUnderLoad;
  const writes = await writer;
  const writesSent = writes.sent;
  if (withWrites && writesSent === 0)
    throw new Error(
      "the concurrent tx stream sent nothing" +
        (writes.lastError ? ` (${writes.lastError})` : "") +
        ". The interference half of this report would compare an idle chain with an idle chain.",
    );

  const history = await historicalDepth();

  const errors = capacity.cold.errors + capacity.warm.errors;
  const errorRate = errors / Math.max(1, capacity.samples.length);
  if (errorRate > MAX_ERROR_RATE)
    throw new Error(
      `${errors}/${capacity.samples.length} observations failed (${(errorRate * 100).toFixed(1)}%). ` +
        "That is not a capacity result: a node refuses a bad call faster than it serves a good one, " +
        "so a failing load looks like an enormous one. Either the node is saturated to the point of " +
        "rejecting work -- which is itself the answer, at a lower --concurrency -- or the read set " +
        "does not match this deployment.",
    );
  // Served observations only. Counting rejections would inflate throughput exactly when the node is
  // in the most trouble.
  const observationsPerSecond =
    (capacity.samples.length - errors) / (capacity.elapsedMs / 1000);
  const readsPerSecond = observationsPerSecond * READS_PER_OBSERVATION;
  // What the environment needs: every agent rebuilds its observation once per block.
  const requiredObservationsPerSecond = agents / config.blockTimeSec;

  const report = {
    tool: "rpc-stress",
    issue: 36,
    ranAt: new Date().toISOString(),
    target: {
      readRpcUrl: readUrl,
      writeRpcUrl: config.rpcUrl,
      chainId: config.chainId,
      chainMode: config.chainMode,
      splitReadWrite: config.readRpcUrl !== config.rpcUrl,
    },
    workload: {
      agents,
      readsPerObservation: READS_PER_OBSERVATION,
      concurrency,
      seconds,
      writeStream: withWrites,
      writesSent,
    },
    capacity: {
      observations: capacity.samples.length,
      observationsPerSecond: Number(observationsPerSecond.toFixed(1)),
      readsPerSecond: Number(readsPerSecond.toFixed(1)),
      cold: capacity.cold,
      warm: capacity.warm,
    },
    requirement: {
      blockTimeSec: config.blockTimeSec,
      observationsPerSecond: Number(requiredObservationsPerSecond.toFixed(2)),
      headroom: Number(
        (observationsPerSecond / requiredObservationsPerSecond).toFixed(1),
      ),
    },
    interference: {
      baseline: { ...jitter(baseline.intervalsMs), blocks: baseline.blocks },
      underReadLoad: { ...jitter(loaded.intervalsMs), blocks: loaded.blocks },
    },
    history,
  };

  const outDir = flags.out ?? config.runDirRoot;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `rpc-stress-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  const base = report.interference.baseline;
  const load = report.interference.underReadLoad;
  console.error(
    [
      "",
      `[rpc-stress] capacity: ${report.capacity.observationsPerSecond} observations/s ` +
        `(${report.capacity.readsPerSecond} reads/s)`,
      `[rpc-stress]   cold p50/p99 ${capacity.cold.p50}/${capacity.cold.p99}ms · ` +
        `warm p50/p99 ${capacity.warm.p50}/${capacity.warm.p99}ms · ${errors} error(s)`,
      `[rpc-stress] requirement: ${agents} agents at ${config.blockTimeSec}s blocks needs ` +
        `${report.requirement.observationsPerSecond}/s -> ${report.requirement.headroom}x headroom`,
      `[rpc-stress] block interval: ${base.meanMs}±${base.sdMs}ms idle (max ${base.maxMs}) · ` +
        `${load.meanMs}±${load.sdMs}ms under load (max ${load.maxMs})`,
      `[rpc-stress] history: eth_call answered ${history.deepestOk ?? 0} blocks back of ${history.head}`,
      `[rpc-stress] verdict: ${verdict(report)}`,
      `[rpc-stress] wrote ${outPath}`,
    ].join("\n"),
  );
}

// The architecture outcome #36 asks for, stated rather than left to the reader. It is a
// recommendation from one measurement, not a conclusion: rerun it against the candidate chain.
function verdict(report: {
  requirement: { headroom: number };
  interference: {
    baseline: { meanMs: number; sdMs: number };
    underReadLoad: { meanMs: number; sdMs: number; maxMs: number };
  };
}): string {
  const { headroom } = report.requirement;
  const base = report.interference.baseline;
  const load = report.interference.underReadLoad;
  const stalled =
    base.meanMs > 0 &&
    load.maxMs > base.meanMs * 2 &&
    load.sdMs > base.sdMs * 2;
  if (headroom < 1)
    return "read capacity is below the requirement — a replica is not optional, the roster does not fit on this node";
  if (stalled)
    return "read load disturbs block production — split reads onto a replica (sequencer + replica)";
  if (headroom < 3)
    return `only ${headroom}x headroom — sequencer-only fits today but leaves no room to grow the roster`;
  return "sequencer-only is sufficient at this roster size";
}

export async function runRpcStress(): Promise<void> {
  await main();
}
