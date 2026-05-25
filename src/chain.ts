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
import { erc20Abi, wethAbi } from "./abis.js";
import { TOKENS, WHALES } from "./constants.js";
import type { BalanceSnapshot } from "./types.js";

export function makeChain(chainId: number) {
  return {
    id: chainId,
    name: "arbitrum-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  } as const;
}

export function makeClients(rpcUrl: string, chainId: number) {
  const chain = makeChain(chainId);
  // Arbitrum フォークは GMX Reader / Aave 読み取りが重いため timeout を広げる
  const transport = http(rpcUrl, { timeout: 120_000, retryCount: 2 });
  return {
    chain,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport }),
  };
}

export function accountAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export async function getBalances(
  publicClient: PublicClient,
  address: Address,
): Promise<BalanceSnapshot> {
  const [ethWei, wethWei, usdcUnits] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: TOKENS.WETH.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    publicClient.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  return { ethWei, wethWei, usdcUnits };
}

// ---------------------------------------------------------------------------
// anvil cheatcodes（既存の publicClient.request 方式を踏襲）
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

export async function resetFork(publicClient: PublicClient): Promise<void> {
  await publicClient.request({
    method: "anvil_reset",
    params: [],
  } as AnvilRequest);
}

function erc20BalanceStorageSlot(holder: Address, mappingSlot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(mappingSlot)],
    ),
  );
}
function pad32Hex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}
// フォールバック用（通常は whale / deposit を使う）
export async function setErc20Balance(
  publicClient: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
  mappingSlot: number,
): Promise<void> {
  await publicClient.request({
    method: "anvil_setStorageAt",
    params: [
      token,
      erc20BalanceStorageSlot(holder, mappingSlot),
      pad32Hex(amount),
    ],
  } as AnvilRequest);
}

// ---------------------------------------------------------------------------
// tx 送信ヘルパ（--no-mining 前提：送信→mine→receipt）
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

// impersonated アドレスから送信（whale / admin / role-admin など）
export async function sendAsImpersonated(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  from: Address,
  tx: { to: Address; data?: Hex; value?: bigint },
): Promise<Hex> {
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
  return hash;
}

// ---------------------------------------------------------------------------
// 資金調達（Arbitrum）：ETH=setBalance / WETH=deposit / USDC=whale transfer
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
): Promise<void> {
  const address = accountAddress(privateKey);
  // WETH deposit と gas を賄えるよう多めに ETH を付与してから wrap
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
    await fundUsdcFromWhale(
      publicClient,
      walletClient,
      chain,
      address,
      usdcUnits,
    );
  }
}

export async function fundUsdcFromWhale(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  to: Address,
  amount: bigint,
): Promise<void> {
  for (const whale of WHALES.USDC) {
    const balance = (await publicClient.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [whale],
    })) as bigint;
    if (balance < amount) continue;
    await setEthBalance(publicClient, whale, GAS_BUFFER_WEI);
    await impersonate(publicClient, whale);
    await sendAsImpersonated(publicClient, walletClient, chain, whale, {
      to: TOKENS.USDC.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
      }),
    });
    await stopImpersonate(publicClient, whale);
    return;
  }
  throw new Error(`no USDC whale with >= ${amount} units at fork block`);
}

export function snapshotForLog(snapshot: BalanceSnapshot) {
  return {
    eth: formatUnits(snapshot.ethWei, 18),
    weth: formatUnits(snapshot.wethWei, 18),
    usdc: formatUnits(snapshot.usdcUnits, 6),
  };
}
