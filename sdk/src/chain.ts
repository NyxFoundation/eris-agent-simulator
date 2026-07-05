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
  const transport = http(rpcUrl, {
    timeout: 120_000,
    retryCount: 2,
    batch: opts.batch ? true : undefined,
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
// Unified stable accounting: usdcUnits is the sum of the active stables (native USDC / USDC.e / USDT).
// All are treated as 6-decimal and worth $1. The coordinator sets the active set from the enabled adapters.
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
  const usdcUnits = stableBalances.reduce((sum, b) => sum + b, 0n);
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
// anvil cheatcodes
// ---------------------------------------------------------------------------

type AnvilRequest = Parameters<PublicClient["request"]>[0];

export async function setEthBalance(
  publicClient: PublicClient,
  address: Address,
  valueWei: bigint,
): Promise<void> {
  await publicClient.request({
    method: "anvil_setBalance",
    params: [address, `0x${valueWei.toString(16)}`],
  } as AnvilRequest);
}

export async function impersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  await publicClient.request({
    method: "anvil_impersonateAccount",
    params: [address],
  } as AnvilRequest);
}

export async function stopImpersonate(
  publicClient: PublicClient,
  address: Address,
): Promise<void> {
  await publicClient.request({
    method: "anvil_stopImpersonatingAccount",
    params: [address],
  } as AnvilRequest);
}

export async function increaseTime(
  publicClient: PublicClient,
  seconds: number,
): Promise<void> {
  await publicClient.request({
    method: "evm_increaseTime",
    params: [`0x${seconds.toString(16)}`],
  } as AnvilRequest);
}

export async function mine(
  publicClient: PublicClient,
  blocks = 1,
): Promise<void> {
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
  await mine(publicClient);
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
// Funding (Arbitrum): ETH=setBalance / WETH=deposit / stable=dealErc20
// ---------------------------------------------------------------------------

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
): Promise<void> {
  const address = accountAddress(privateKey);
  await setEthBalance(publicClient, address, ethWei + wethWei + GAS_BUFFER_WEI);
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
    // Grant usdcUnits to each active stable (so each stable has inventory cross-venue)
    for (const token of ACTIVE_STABLES) {
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

export function snapshotForLog(snapshot: BalanceSnapshot) {
  return {
    eth: formatUnits(snapshot.ethWei, 18),
    weth: formatUnits(snapshot.wethWei, 18),
    usdc: formatUnits(snapshot.usdcUnits, 6),
  };
}
