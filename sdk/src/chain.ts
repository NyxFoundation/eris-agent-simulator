import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { erc20Abi, wethAbi } from "./abis.js";
import { MULTICALL3, TOKENS } from "./constants.js";
import { baseTokens, tokenInfo } from "./markets.js";
import { isParStable } from "./stables.js";
import type { BalanceSnapshot, TokenSymbol } from "./types.js";

export function makeChain(chainId: number) {
  return {
    id: chainId,
    name: "arbitrum-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
    // Referenced by viem's batch.multicall (auto-aggregates same-tick readContract calls into a single Multicall3)
    contracts: { multicall3: { address: MULTICALL3 } },
  } as const;
}

export function makeClients(
  rpcUrl: string,
  chainId: number,
  opts: { batch?: boolean } = {},
) {
  const chain = makeChain(chainId);
  // Widen the timeout because on an Arbitrum fork the GMX Reader / Aave reads are heavy.
  // batch=true enables (1) JSON-RPC array batching (same-tick requests into one HTTP) and
  // (2) Multicall3 auto-aggregation of readContract. A direct-mode agent issues a dozen-plus reads
  // per block, so without batching anvil's round-trip count becomes the bottleneck
  // (ADR 0006 Risks "anvil bottleneck", lever 1).
  // Self-hosted agents (trial period) reach the chain through the operator RPC gateway behind
  // Cloudflare Access. Inject the service-token headers (and any extra headers) from the env so
  // viems fetch carries them. Unset in the operators internal sim (direct anvil) -> no headers.
  const headers: Record<string, string> = {};
  const cfId = process.env.CF_ACCESS_CLIENT_ID;
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }
  if (process.env.ERIS_RPC_HEADERS) {
    try {
      Object.assign(headers, JSON.parse(process.env.ERIS_RPC_HEADERS));
    } catch {
      // ERIS_RPC_HEADERS must be a JSON object of header name -> value; ignore if malformed
    }
  }
  const transport = http(rpcUrl, {
    timeout: 120_000,
    retryCount: 2,
    batch: opts.batch ? true : undefined,
    fetchOptions: Object.keys(headers).length ? { headers } : undefined,
  });
  return {
    chain,
    publicClient: createPublicClient({
      chain,
      transport,
      batch: opts.batch ? { multicall: true } : undefined,
    }),
    walletClient: createWalletClient({ chain, transport }),
  };
}

export function accountAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

// ---------------------------------------------------------------------------
// The run's stables. The coordinator sets the active set from the enabled adapters (each venue's
// stable leg, plus any stable a venue issues).
//
// usdcUnits used to be the sum of all of them, on the convention that native USDC / USDC.e / USD₮0
// are interchangeable dollars. Issue #27 narrowed it to native USDC alone, for two reasons. As a
// *budget* -- which is the only thing the nine participant-facing uses do with it -- the sum was
// already wrong: USDT cannot be spent in a USDC pool, and funding grants the configured amount to
// each stable, so the sum read roughly double what any single venue would accept. And as soon as one
// stable is priced from a market rather than asserted at par (stables.ts), summing them at face
// value states a total that no longer exists. The per-stable breakdown lives in `stables`.
// ---------------------------------------------------------------------------
let ACTIVE_STABLES: Address[] = [TOKENS.USDC.address];

export function setActiveStables(addresses: Address[]): void {
  const seen = new Set<string>();
  const list: Address[] = [];
  for (const a of [TOKENS.USDC.address, ...addresses]) {
    const lower = a.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    list.push(a);
  }
  ACTIVE_STABLES = list;
}

export function activeStables(): Address[] {
  return ACTIVE_STABLES;
}

// ---------------------------------------------------------------------------
// Multi-asset accounting (ADR 0013): bases is the inventory map of base tokens (WETH/WBTC…).
// Same shape as ACTIVE_STABLES; the coordinator sets the active set from the enabled markets.
// With the default [WETH], getBalances/fundWallet match the old behavior exactly (WETH byte-compatible).
// ---------------------------------------------------------------------------
let ACTIVE_BASES: Address[] = [TOKENS.WETH.address];

export function setActiveBases(addresses: Address[]): void {
  const seen = new Set<string>();
  const list: Address[] = [];
  for (const a of [TOKENS.WETH.address, ...addresses]) {
    const lower = a.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    list.push(a);
  }
  ACTIVE_BASES = list;
}

export function activeBases(): Address[] {
  return ACTIVE_BASES;
}

// base address (lower) -> symbol. Reverse lookup from the registry's base tokens (WETH is always "WETH").
function baseSymbolFor(address: Address): TokenSymbol {
  const lower = address.toLowerCase();
  if (lower === TOKENS.WETH.address.toLowerCase()) return "WETH";
  const match = baseTokens().find((t) => t.address.toLowerCase() === lower);
  return match?.symbol ?? address;
}

export async function getBalances(
  publicClient: PublicClient,
  address: Address,
): Promise<BalanceSnapshot> {
  const [ethWei, wethWei, ...rest] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: TOKENS.WETH.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    // base balances (including WETH; WETH is the same read as wethWei but is read again to line up the bases keys).
    ...ACTIVE_BASES.map((token) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ),
    ...ACTIVE_STABLES.map((token) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ),
  ]);
  const baseBalances = (rest as bigint[]).slice(0, ACTIVE_BASES.length);
  const stableBalances = (rest as bigint[]).slice(ACTIVE_BASES.length);
  const bases: Record<string, bigint> = {};
  ACTIVE_BASES.forEach((token, i) => {
    // Treat wethWei as authoritative for WETH and make bases["WETH"] match it (byte-compatible).
    const lower = token.toLowerCase();
    bases[baseSymbolFor(token)] =
      lower === TOKENS.WETH.address.toLowerCase() ? wethWei : baseBalances[i];
  });
  const stables: Record<string, bigint> = {};
  ACTIVE_STABLES.forEach((token, i) => {
    stables[token.toLowerCase()] = stableBalances[i];
  });
  // Native USDC alone (issue #27 (a) step 2). Narrowing only ever makes an agent trade smaller;
  // leaving it summed made agents overstate their dollars exactly when a stable depegs.
  const usdcUnits = stables[TOKENS.USDC.address.toLowerCase()] ?? 0n;
  return { ethWei, wethWei, usdcUnits, bases, stables };
}

// Balance of a single stable (so an adapter can check its own stable inventory)
export async function tokenBalance(
  publicClient: PublicClient,
  token: Address,
  address: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Chain mode (issue #33 / ADR 0021 §7)
//
// `anvil` is the historical mode: the environment owns a dev node and reaches for cheatcodes to fund
// wallets, mine blocks and reset the world. `external` is a real client (the OP Stack devnet of #35),
// where none of those RPCs exist.
//
// The distinction is a module-level switch rather than a parameter threaded through every call site
// because the cheatcodes are called from ~30 places across three packages, and the failure this
// guards against is *silent*: an unknown RPC method on a real node returns an error object that most
// of these call sites swallow, so a run would fund nobody, mine nothing, and still report a completed
// competition. Failing at the call is the only way that stays visible.
// ---------------------------------------------------------------------------

export type ChainMode = "anvil" | "external";

let CHAIN_MODE: ChainMode = "anvil";
let TREASURY_PK: Hex | undefined;

export function setChainMode(mode: ChainMode, treasuryPrivateKey?: Hex): void {
  CHAIN_MODE = mode;
  TREASURY_PK = treasuryPrivateKey;
}

export function chainMode(): ChainMode {
  return CHAIN_MODE;
}

export function isExternalChain(): boolean {
  return CHAIN_MODE === "external";
}

// Every cheatcode entry point goes through this. The message names the #33 work item that replaces
// it, so a run that trips one says what has to change rather than which RPC was missing.
function requireDevNode(op: string, replacement: string): void {
  if (CHAIN_MODE !== "external") return;
  throw new Error(
    `${op} is an anvil cheatcode and this run is on an external chain (run.chainMode: external). ` +
      `${replacement} (issue #33 / ADR 0021 §7)`,
  );
}

function requireTreasury(op: string): Hex {
  if (!TREASURY_PK)
    throw new Error(
      `${op} on an external chain needs a treasury key: set TREASURY_PRIVATE_KEY in .env.local ` +
        "(it is the account genesis prefunds, and the only source of ETH and tokens on a chain " +
        "with no cheatcodes -- issue #33 (1))",
    );
  return TREASURY_PK;
}

type AnvilRequest = Parameters<PublicClient["request"]>[0];

export async function setEthBalance(
  publicClient: PublicClient,
  address: Address,
  valueWei: bigint,
): Promise<void> {
  requireDevNode(
    "setEthBalance",
    "fund from the treasury EOA instead (transferEth / fundWallet)",
  );
  await publicClient.request({
    method: "anvil_setBalance",
    params: [address, `0x${valueWei.toString(16)}`],
  } as AnvilRequest);
}

export async function impersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  requireDevNode(
    "impersonate",
    "an external chain has no impersonation; hold the key or drop the call",
  );
  await publicClient.request({
    method: "anvil_impersonateAccount",
    params: [address],
  } as AnvilRequest);
}

export async function stopImpersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  requireDevNode("stopImpersonate", "see impersonate");
  await publicClient.request({
    method: "anvil_stopImpersonatingAccount",
    params: [address],
  } as AnvilRequest);
}

export async function increaseTime(
  publicClient: PublicClient,
  seconds: number,
): Promise<void> {
  requireDevNode(
    "increaseTime",
    "a real chain's clock is wall time; the fork-skew warp it exists for does not apply (issue #33 (4))",
  );
  await publicClient.request({
    method: "evm_increaseTime",
    params: [`0x${seconds.toString(16)}`],
  } as AnvilRequest);
}

export async function mine(
  publicClient: PublicClient,
  blocks = 1,
): Promise<void> {
  requireDevNode(
    "mine",
    "the sequencer produces blocks; wait for the tx receipt instead (issue #33 (2))",
  );
  await publicClient.request({
    method: "anvil_mine",
    params: [`0x${blocks.toString(16)}`],
  } as AnvilRequest);
}

// Real-time block production: every `seconds` seconds, mine the mempool into a single block.
// After flushing setup fast (no-mining + sendAndMine), call this at the start of the competition
// phase to switch to a real N-second cadence. --order fees also sorts the mempool by descending fee
// on these interval mines. seconds=0 stops interval mining (for teardown).
export async function setIntervalMining(
  publicClient: PublicClient,
  seconds: number,
): Promise<void> {
  requireDevNode(
    "setIntervalMining",
    "the sequencer sets the block time; configure it in the chain's rollup config (issue #33 (2))",
  );
  await publicClient.request({
    method: "anvil_setIntervalMining",
    params: [seconds],
  } as AnvilRequest);
}

// Enable/disable automine. When true, each tx is mined immediately and in-block fee competition
// stops working (each tx becomes its own block). In real-time mode keep it false and use interval mining.
export async function setAutomine(
  publicClient: PublicClient,
  enabled: boolean,
): Promise<void> {
  requireDevNode("setAutomine", "see setIntervalMining");
  await publicClient.request({
    method: "evm_setAutomine",
    params: [enabled],
  } as AnvilRequest);
}

export type ResetForkOptions = {
  // Upstream fork RPC (ARB_RPC_URL). When set, anvil_reset with forking rebuilds the fork from
  // scratch, fully discarding the previous run/seed's local changes (Aave positions, reserve
  // timestamps, etc.). If unset, falls back to anvil_reset [] (note: state persists).
  forkUrl?: string;
  // Re-fork target block (FORK_BLOCK_NUMBER). Pinning it makes reruns fully reproducible.
  forkBlockNumber?: number;
  // Local (non-fork) deploy mode. Reset via evm_snapshot/evm_revert instead of re-forking.
  localDeploy?: boolean;
  // Persistence file for the local-mode snapshot ID. Shares the clean cross-section across runs in separate processes.
  localSnapshotFile?: string;
};

// Re-fork target block captured once within the same process. multiSeedRun runs all SEEDs in a
// single process, so pin it here to make every seed share the same fork block (= the same DeFi liquidity baseline).
let capturedForkBlock: number | undefined;

// Snapshot ID for local deploy mode (revert→re-snapshot between runs within the process).
let localSnapshotId: Hex | undefined;

export async function resetFork(
  publicClient: PublicClient,
  options: ResetForkOptions = {},
): Promise<void> {
  requireDevNode(
    "resetFork",
    "a real chain cannot be rewound; a run becomes fresh-deploy-per-run, or (ADR 0021 §1) the " +
      "practice devnet simply never resets (issue #33 (3))",
  );
  const { forkUrl, forkBlockNumber, localDeploy, localSnapshotFile } = options;
  if (localDeploy) {
    // Non-fork: with no upstream, anvil_reset cannot re-fork. Instead, revert to the "clean
    // cross-section right after deploy" via evm_snapshot/evm_revert. The snapshot is re-taken right
    // after the revert, so it always points at a clean cross-section.
    //
    // cross-process: persist the snapshot ID to a file so runs in other processes also revert to the
    // clean snapshot left by the previous process (assumes sequential startup). Precedence:
    // in-process memory > persisted file.
    //
    // The persisted ID identifies "which anvil instance it belongs to" by the genesis block hash
    // (format `<genesisHash>:<snapshotId>`). The old assumption was that a stale ID after an anvil
    // restart is safe because evm_revert returns false — but that does not hold: if another tool
    // (e.g. aave's hardhat-deploy) creates a snapshot with the same number (0x0 etc.), the IDs
    // collide and it **actually reverts to a different cross-section** (confirmed real damage:
    // deployed venues partially disappear). Ignore a persisted ID from a mismatched instance and
    // use the current state as the base (self-healing).
    const genesisHash = (await publicClient.getBlock({ blockNumber: 0n })).hash;
    let revertTo = localSnapshotId;
    if (!revertTo && localSnapshotFile && existsSync(localSnapshotFile)) {
      const persisted = readFileSync(localSnapshotFile, "utf8").trim();
      const [hash, id] = persisted.split(":");
      // Treat the old format (bare ID, no instance identification) as stale and ignore it.
      if (hash && id && hash === genesisHash) revertTo = id as Hex;
    }
    if (revertTo) {
      await publicClient
        .request({ method: "evm_revert", params: [revertTo] } as AnvilRequest)
        .catch(() => {
          /* stale id: use the current state as the base */
        });
    }
    localSnapshotId = (await publicClient.request({
      method: "evm_snapshot",
      params: [],
    } as AnvilRequest)) as Hex;
    if (localSnapshotFile) {
      try {
        writeFileSync(localSnapshotFile, `${genesisHash}:${localSnapshotId}`);
      } catch {
        /* even if persistence fails, in-process still works */
      }
    }
    return;
  }
  if (!forkUrl) {
    // Upstream RPC unknown → soft reset. State is not fully cleared, so when running multiple
    // runs/seeds on the same anvil, restart anvil each time or set forkUrl.
    await publicClient.request({
      method: "anvil_reset",
      params: [],
    } as AnvilRequest);
    return;
  }
  // Pin the block for reproducibility. Precedence: explicit > already captured in-process > capture now.
  const blockNumber = forkBlockNumber ?? capturedForkBlock;
  await publicClient.request({
    method: "anvil_reset",
    params: [
      {
        forking:
          blockNumber !== undefined
            ? { jsonRpcUrl: forkUrl, blockNumber }
            : { jsonRpcUrl: forkUrl },
      },
    ],
  } as AnvilRequest);
  if (blockNumber === undefined) {
    // Capture latest and reuse it in subsequent resetFork calls (ensures determinism within the same process).
    capturedForkBlock = Number((await publicClient.getBlock()).number);
  }
}

export async function setStorageAt(
  publicClient: PublicClient,
  token: Address,
  slotKey: Hex,
  value: Hex,
): Promise<void> {
  requireDevNode(
    "setStorageAt",
    "storage cannot be written from outside on a real chain; the economicGas profile (ADR 0011) " +
      "is unusable there and needs the tx-based redesign of issue #33 (2)",
  );
  await publicClient.request({
    method: "anvil_setStorageAt",
    params: [token, slotKey, value],
  } as AnvilRequest);
}

// Encode a bigint into a 32-byte storage word (negative int256 values as two's complement).
// For anvil_setStorageAt. Used by the environment's price state-write (ADR 0011 §1).
export function bigintToStorageWord(value: bigint): Hex {
  const masked = value < 0n ? (1n << 256n) + value : value;
  return pad32(masked);
}

function balanceSlotKey(holder: Address, mappingSlot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(mappingSlot)],
    ),
  );
}
function pad32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

// Grant an ERC20 balance via storage overwrite. Auto-probe balanceOf's mapping slot over 0..MAX
// (native USDC is slot 9, etc.; works even for proxies since balances live in the proxy's own storage).
const PROBE_SENTINEL = 0x1234567890abcdef1234567890abcdefn;

// Candidate mapping slots for balanceOf (most common first). A proxy (OZ upgradeable) often lands near 51 due to the gap.
function candidateSlots(): number[] {
  const priority = [9, 0, 2, 3, 1, 51, 52, 53, 4, 5, 6, 7, 8, 10, 11];
  const seen = new Set(priority);
  const rest: number[] = [];
  for (let s = 0; s <= 200; s++) if (!seen.has(s)) rest.push(s);
  return [...priority, ...rest];
}

export async function dealErc20(
  publicClient: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  requireDevNode(
    "dealErc20",
    "grant tokens from the treasury instead (grantErc20: mint if the token allows it, else transfer) " +
      "(issue #33 (1))",
  );
  for (const slot of candidateSlots()) {
    const key = balanceSlotKey(holder, slot);
    const original = ((await publicClient.getStorageAt({
      address: token,
      slot: key,
    })) ?? `0x${"0".repeat(64)}`) as Hex;
    await setStorageAt(publicClient, token, key, pad32(PROBE_SENTINEL));
    const probed = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
    if (probed === PROBE_SENTINEL) {
      await setStorageAt(publicClient, token, key, pad32(amount));
      return;
    }
    await setStorageAt(publicClient, token, key, original);
  }
  throw new Error(`could not locate ERC20 balance slot for token ${token}`);
}

// ---------------------------------------------------------------------------
// tx send helper (assumes --no-mining: send→mine→receipt)
// ---------------------------------------------------------------------------

export async function sendAndMine(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  tx: { to: Address; data?: Hex; value?: bigint },
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  // On an external chain the sequencer decides when this lands; the wait is the whole mechanism
  // (issue #33 (2)). Every setup path here reads back the state the tx wrote, so returning before
  // inclusion would make the caller act on the pre-tx world.
  if (CHAIN_MODE === "anvil") await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// For real-time mode: just drop the tx into the mempool (no mine, no receipt wait).
// You can specify priorityFee so --order fees includes it in the next block under interval mining.
// Since we want the oracle update ahead of the agents (txIndex 0), the caller passes a fee above the
// agent cap. Setting tx.gas explicitly skips viem's eth_estimateGas (= EVM execution). Set it for
// routine per-block txs like oracle writes so they are not held up when anvil's execution queue backs
// up under agent load.
export async function sendNoMine(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
  priorityFeeWei: bigint,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  return walletClient.sendTransaction({
    account,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
    maxFeePerGas: baseFee + priorityFeeWei,
    maxPriorityFeePerGas: priorityFeeWei,
  });
}

// Several transactions from one key, waiting once.
//
// On a dev node every `sendAndMine` mines its own block, so a hundred setup transactions cost
// nothing. On a chain the environment does not mine, each one waits for the sequencer: funding
// fifteen wallets at roughly eighteen transactions each, at a two-second block time, is nine
// minutes of silence before the first agent trades. Measured, not estimated -- the first
// external-mode run sat in the funding loop for over six minutes with four events written.
//
// Nonces are assigned explicitly rather than left to viem, which re-reads the pending count per
// send and would hand two overlapping sends the same one. And because they are sequential and from
// a single sender, the last transaction cannot be included before the earlier ones -- so waiting for
// its receipt is waiting for all of them, not an approximation of it.
export async function sendBatch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  txs: Array<{ to: Address; data?: Hex; value?: bigint; gas?: bigint }>,
): Promise<Hex[]> {
  if (txs.length === 0) return [];
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  let nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const hashes: Hex[] = [];
  for (const tx of txs) {
    hashes.push(
      await walletClient.sendTransaction({
        account,
        chain,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas: tx.gas,
        nonce: nonce++,
        maxFeePerGas: baseFee + 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    );
  }
  if (CHAIN_MODE === "anvil") await mine(publicClient);
  await publicClient.waitForTransactionReceipt({
    hash: hashes[hashes.length - 1],
  });
  return hashes;
}

// Send a transaction that has to come from one particular address -- a venue's role admin, an ACL
// admin. On a fork that address belongs to somebody else (a mainnet multisig), so the only way is to
// impersonate it. On a chain the environment deployed itself, it is *our own account*: the deployer,
// which is also the treasury (issue #33 (1)/(4)).
//
// So this picks the mechanism rather than the caller doing it, and on an external chain it refuses
// loudly when the address is not one we hold. That case is a deployment whose admin keys the
// environment does not control, which is not a smaller problem than a missing cheatcode.
export async function sendAsPrivileged(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  from: Address,
  tx: { to: Address; data?: Hex; value?: bigint },
  what: string,
): Promise<Hex> {
  if (CHAIN_MODE !== "external")
    return sendAsImpersonated(publicClient, walletClient, chain, from, tx);
  const treasuryPk = requireTreasury(what);
  if (accountAddress(treasuryPk).toLowerCase() !== from.toLowerCase())
    throw new Error(
      `${what} has to be sent by ${from}, which is not the treasury ` +
        `(${accountAddress(treasuryPk)}). On an external chain there is no impersonation, so the ` +
        "environment can only act as an admin whose key it holds -- redeploy with the treasury as " +
        "that role's admin (issue #33 (4))",
    );
  return sendAndMine(publicClient, walletClient, chain, treasuryPk, tx);
}

// Send from an impersonated address (role-admin / acl-admin, etc.)
export async function sendAsImpersonated(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  from: Address,
  tx: { to: Address; data?: Hex; value?: bigint },
): Promise<Hex> {
  await setEthBalance(publicClient, from, 10n ** 21n);
  await impersonate(publicClient, from);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await walletClient.sendTransaction({
    account: from,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  await stopImpersonate(publicClient, from);
  return hash;
}

// ---------------------------------------------------------------------------
// Treasury funding (issue #33 (1)): the cheatcode-free half of fundWallet.
//
// On a chain with no `anvil_setBalance` and no `anvil_setStorageAt`, every wei and every token unit
// an agent starts with has to be *sent* to it. The source is one treasury EOA that the chain's
// genesis prefunds (#35 genesis design), and the tokens are the environment's own contracts:
// MockERC20 exposes `mint`, so a grant is a mint when the treasury is allowed to mint and a plain
// transfer otherwise (WETH9 is always the latter -- it only mints against deposited ETH).
// ---------------------------------------------------------------------------

const mintableAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// token -> whether the treasury may mint it. Probed once per token per process: the answer is a
// property of the deployment, and funding N wallets would otherwise pay for N identical eth_calls.
const treasuryCanMint = new Map<string, boolean>();

async function canTreasuryMint(
  publicClient: PublicClient,
  token: Address,
  treasury: Address,
): Promise<boolean> {
  const key = token.toLowerCase();
  const cached = treasuryCanMint.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await publicClient.simulateContract({
      address: token,
      abi: mintableAbi,
      functionName: "mint",
      args: [treasury, 1n],
      account: treasury,
    });
    ok = true;
  } catch {
    ok = false; // no mint(), or the treasury is not the minter -> fall back to a transfer
  }
  treasuryCanMint.set(key, ok);
  return ok;
}

// Whether *anyone* can mint this token. On a dev node that is a convenience; on a public practice
// chain it is free money, and every score computed on it is meaningless. Probed from an address that
// holds nothing and is nobody's minter, so a success is unambiguous.
const UNPRIVILEGED_PROBE: Address =
  "0x00000000000000000000000000000000000eA15E";

export async function isPermissionlesslyMintable(
  publicClient: PublicClient,
  token: Address,
): Promise<boolean> {
  try {
    await publicClient.simulateContract({
      address: token,
      abi: mintableAbi,
      functionName: "mint",
      args: [UNPRIVILEGED_PROBE, 1n],
      account: UNPRIVILEGED_PROBE,
    });
    return true;
  } catch {
    return false;
  }
}

export async function transferEth(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  fromPrivateKey: Hex,
  to: Address,
  valueWei: bigint,
): Promise<Hex | null> {
  if (valueWei <= 0n) return null;
  const account = privateKeyToAccount(fromPrivateKey);
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to,
    value: valueWei,
    gas: 21_000n,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  if (CHAIN_MODE === "anvil") await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// Put `amount` of `token` in `holder`'s hands, without cheatcodes: mint it if the treasury may,
// otherwise send it from the treasury's own balance. A transfer that runs the treasury dry throws
// with the token named, because the alternative is an agent that silently starts with nothing and
// looks, in every artifact, exactly like an agent that chose not to trade.
export async function grantErc20(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) return;
  const treasuryPk = requireTreasury("grantErc20");
  const treasury = accountAddress(treasuryPk);
  if (await canTreasuryMint(publicClient, token, treasury)) {
    await sendAndMine(publicClient, walletClient, chain, treasuryPk, {
      to: token,
      data: encodeFunctionData({
        abi: mintableAbi,
        functionName: "mint",
        args: [holder, amount],
      }),
    });
    return;
  }
  const held = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  })) as bigint;
  if (held < amount)
    throw new Error(
      `treasury cannot fund ${amount} of token ${token}: it holds ${held} and the token does not ` +
        "let it mint. Prefund the treasury in genesis, or give it the minter role (issue #33 (1))",
    );
  await sendAndMine(publicClient, walletClient, chain, treasuryPk, {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [holder, amount],
    }),
  });
}

// ---------------------------------------------------------------------------
// Funding (Arbitrum): ETH=setBalance / WETH=deposit / stable=dealErc20
// ---------------------------------------------------------------------------

// Gas headroom granted *on top of* the requested inventory. It exists for environment machinery
// (flow bots, the whale, admin top-ups that pass ethWei=0 and pay for the grant out of this buffer):
// running those dry silently removes market flow, so they get slack.
//
// Scored wallets must NOT take it. ADR 0019 §6: the epoch series is live-marked, so every wei of ETH
// an agent did not ask for is unchosen β in its own std term. Under the endowment that ADR proposes
// (1 ETH + 100k USDC) the buffer alone would be 5x the intended gas reserve -- 15.2% of the portfolio
// in ETH instead of 2.9%. The coordinator therefore passes `gasBufferWei: 0n` for agent wallets, which
// makes `funding.ethWei` the wallet's actual native balance (minus the gas of the WETH wrap below,
// when the roster asks for base inventory) and makes the ERIS_ECONOMIC_GAS lower-bound check in
// coordinator.ts validate the balance the agent really gets.
const GAS_BUFFER_WEI = 5_000_000_000_000_000_000n; // 5 ETH

export async function fundWallet(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  ethWei: bigint,
  wethWei: bigint,
  usdcUnits: bigint,
  // ADR 0013: base inventory other than WETH (symbol -> amount). Default is to grant none (WBTC starts at 0 by policy).
  // WETH here is ignored (the deposit path above is authoritative).
  baseAmounts?: Record<string, bigint>,
  gasBufferWei: bigint = GAS_BUFFER_WEI,
): Promise<void> {
  const address = accountAddress(privateKey);
  if (CHAIN_MODE === "external") {
    // Identical to funding an address whose key nobody here holds: the treasury sends everything,
    // including the WETH, rather than sending ETH and having the recipient wrap it. Nothing about
    // the endowment changes -- what changes is that every transaction has one sender, which is what
    // lets them go out as a batch instead of one block-wait each.
    //
    // It also makes `funding.ethWei` exactly the wallet's native balance, rather than that minus
    // whatever the wrap cost, which is what ADR 0019 §6 asks for.
    await fundAddress(
      publicClient,
      walletClient,
      chain,
      address,
      ethWei,
      wethWei,
      usdcUnits,
      baseAmounts,
      gasBufferWei,
    );
    return;
  }
  await setEthBalance(publicClient, address, ethWei + wethWei + gasBufferWei);
  if (wethWei > 0n) {
    await sendAndMine(publicClient, walletClient, chain, privateKey, {
      to: TOKENS.WETH.address,
      data: encodeFunctionData({
        abi: wethAbi,
        functionName: "deposit",
        args: [],
      }),
      value: wethWei,
    });
  }
  if (usdcUnits > 0n) {
    // Grant the endowment to each *par* stable, so every venue's USDC-equivalent leg has inventory.
    //
    // Market-priced stables are deliberately excluded (issue #27). Two reasons: conjuring eUSD with
    // a cheatcode would put stablecoin into circulation that no Trove ever borrowed, and endowing
    // everyone with a stable that is about to depeg makes the loss β on a position nobody chose. A
    // market-priced stable has to be bought, which is what makes holding one a decision.
    for (const token of ACTIVE_STABLES) {
      if (!isParStable(token)) continue;
      await dealErc20(publicClient, token, address, usdcUnits);
    }
  }
  if (baseAmounts) {
    for (const [symbol, amount] of Object.entries(baseAmounts)) {
      // WETH is handled via the deposit path. Do not grant 0.
      if (symbol === "WETH" || amount <= 0n) continue;
      await dealErc20(publicClient, tokenInfo(symbol).address, address, amount);
    }
  }
}

// Fund an address whose key the environment does not hold (ADR 0021 §2: a registered participant
// who runs the agent themselves). Same endowment as fundWallet, reached without ever signing as the
// recipient: WETH is granted directly rather than wrapped by the holder, since only the holder could
// call `deposit`. Venue approvals are *not* granted here for the same reason -- an approval is the
// holder's signature, so a self-hosted agent sends its own (example/agents/runtime/bot.ts).
export async function fundAddress(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  address: Address,
  ethWei: bigint,
  wethWei: bigint,
  usdcUnits: bigint,
  baseAmounts?: Record<string, bigint>,
  gasBufferWei: bigint = GAS_BUFFER_WEI,
): Promise<void> {
  const targetEth = ethWei + gasBufferWei;
  const grants: Array<{ token: Address; amount: bigint }> = [];
  if (usdcUnits > 0n)
    for (const token of ACTIVE_STABLES)
      if (isParStable(token)) grants.push({ token, amount: usdcUnits });
  if (baseAmounts)
    for (const [symbol, amount] of Object.entries(baseAmounts)) {
      if (symbol === "WETH" || amount <= 0n) continue;
      grants.push({ token: tokenInfo(symbol).address, amount });
    }

  if (CHAIN_MODE !== "external") {
    await setEthBalance(publicClient, address, targetEth);
    if (wethWei > 0n)
      await dealErc20(publicClient, TOKENS.WETH.address, address, wethWei);
    for (const g of grants)
      await dealErc20(publicClient, g.token, address, g.amount);
    return;
  }

  // Everything the treasury has to send for this wallet, planned first and sent once. The reads that
  // decide what is needed are cheap; the sends are what cost a block each, and there were eighteen
  // of them per wallet.
  const treasuryPk = requireTreasury("fundAddress");
  const txs: Array<{ to: Address; data?: Hex; value?: bigint }> = [];
  const held = await publicClient.getBalance({ address });
  // Topped up to the target rather than assigned it -- a real chain cannot set a balance, and the
  // practice devnet funds the same wallet again on a later segment (ADR 0021 §6).
  if (targetEth > held)
    txs.push({ to: address, value: targetEth - held });
  if (wethWei > 0n)
    txs.push(...(await wethGrantTxs(publicClient, treasuryPk, address, wethWei)));
  for (const g of grants)
    txs.push(
      ...(await tokenGrantTxs(publicClient, treasuryPk, g.token, address, g.amount)),
    );
  await sendBatch(publicClient, walletClient, chain, treasuryPk, txs);
}

// The transactions that put `amount` of WETH in `holder`'s hands, or none if it already has them.
//
// WETH9 has no mint: every unit in existence was deposited against ETH. So the treasury wraps its
// own and sends the result, which is the only cheatcode-free way to put WETH in an account whose key
// nobody here holds -- and, since the treasury signs both halves, they batch with everything else.
async function wethGrantTxs(
  publicClient: PublicClient,
  treasuryPk: Hex,
  holder: Address,
  amount: bigint,
): Promise<Array<{ to: Address; data?: Hex; value?: bigint }>> {
  const treasury = accountAddress(treasuryPk);
  const held = (await publicClient.readContract({
    address: TOKENS.WETH.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
  if (held >= amount) return [];
  const short = amount - held;
  const treasuryWeth = (await publicClient.readContract({
    address: TOKENS.WETH.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  })) as bigint;
  const txs: Array<{ to: Address; data?: Hex; value?: bigint }> = [];
  if (treasuryWeth < short)
    txs.push({
      to: TOKENS.WETH.address,
      data: encodeFunctionData({
        abi: wethAbi,
        functionName: "deposit",
        args: [],
      }),
      value: short - treasuryWeth,
    });
  txs.push({
    to: TOKENS.WETH.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [holder, short],
    }),
  });
  return txs;
}

// The transaction that tops `holder` up to `amount` of `token`, or none if it is already there.
// Mint where the treasury may mint, transfer where it may not -- and refuse rather than silently
// under-fund, because an agent that starts with nothing looks, in every artifact, exactly like an
// agent that chose not to trade.
async function tokenGrantTxs(
  publicClient: PublicClient,
  treasuryPk: Hex,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<Array<{ to: Address; data?: Hex; value?: bigint }>> {
  const treasury = accountAddress(treasuryPk);
  const held = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
  if (held >= amount) return [];
  const short = amount - held;
  if (await canTreasuryMint(publicClient, token, treasury))
    return [
      {
        to: token,
        data: encodeFunctionData({
          abi: mintableAbi,
          functionName: "mint",
          args: [holder, short],
        }),
      },
    ];
  const treasuryHeld = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  })) as bigint;
  if (treasuryHeld < short)
    throw new Error(
      `treasury cannot fund ${short} of token ${token}: it holds ${treasuryHeld} and the token does ` +
        "not let it mint. Prefund the treasury in genesis, or give it the minter role (issue #33 (1))",
    );
  return [
    {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [holder, short],
      }),
    },
  ];
}

export function snapshotForLog(snapshot: BalanceSnapshot) {
  return {
    eth: formatUnits(snapshot.ethWei, 18),
    weth: formatUnits(snapshot.wethWei, 18),
    usdc: formatUnits(snapshot.usdcUnits, 6),
  };
}
