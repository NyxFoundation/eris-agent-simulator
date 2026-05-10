import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, wethAbi } from "./abis.js";
import { ADDRESSES } from "./constants.js";
import type { BalanceSnapshot } from "./types.js";

export function makeChain(chainId: number) {
  return {
    id: chainId,
    name: "anvil-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } }
  } as const;
}

export function makeClients(rpcUrl: string, chainId: number) {
  const chain = makeChain(chainId);
  return {
    chain,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ chain, transport: http(rpcUrl) })
  };
}

export function accountAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export async function getBalances(publicClient: PublicClient, address: Address): Promise<BalanceSnapshot> {
  const [ethWei, wethWei, usdcUnits] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: ADDRESSES.weth, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] })
  ]);
  return { ethWei, wethWei, usdcUnits };
}

export async function setEthBalance(publicClient: PublicClient, address: Address, valueWei: bigint): Promise<void> {
  await publicClient.request({
    method: "anvil_setBalance",
    params: [address, `0x${valueWei.toString(16)}`]
  } as Parameters<typeof publicClient.request>[0]);
}

const WETH_BALANCE_MAPPING_SLOT = 3;
const USDC_BALANCE_MAPPING_SLOT = 9;

function erc20BalanceStorageSlot(holder: Address, mappingSlot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(mappingSlot)]
    )
  );
}

function pad32Hex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export async function setErc20Balance(
  publicClient: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
  mappingSlot: number
): Promise<void> {
  await publicClient.request({
    method: "anvil_setStorageAt",
    params: [token, erc20BalanceStorageSlot(holder, mappingSlot), pad32Hex(amount)]
  } as Parameters<typeof publicClient.request>[0]);
}

export async function setWethBalance(publicClient: PublicClient, holder: Address, amount: bigint): Promise<void> {
  await setErc20Balance(publicClient, ADDRESSES.weth, holder, amount, WETH_BALANCE_MAPPING_SLOT);
}

export async function setUsdcBalance(publicClient: PublicClient, holder: Address, amount: bigint): Promise<void> {
  await setErc20Balance(publicClient, ADDRESSES.usdc, holder, amount, USDC_BALANCE_MAPPING_SLOT);
}

export async function mine(publicClient: PublicClient, blocks = 1): Promise<void> {
  await publicClient.request({
    method: "anvil_mine",
    params: [`0x${blocks.toString(16)}`]
  } as Parameters<typeof publicClient.request>[0]);
}

export async function resetFork(publicClient: PublicClient): Promise<void> {
  await publicClient.request({
    method: "anvil_reset",
    params: []
  } as Parameters<typeof publicClient.request>[0]);
}

export async function sendAndMine(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  tx: { to: Address; data?: Hex; value?: bigint }
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
    maxPriorityFeePerGas: 1_000_000_000n
  });
  await mine(publicClient);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function setupWallet(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chain: ReturnType<typeof makeChain>,
  privateKey: Hex,
  initialEthWei: bigint,
  initialWethWei: bigint,
  initialUsdcUnits: bigint
): Promise<void> {
  const address = accountAddress(privateKey);
  await setEthBalance(publicClient, address, initialEthWei);
  await setWethBalance(publicClient, address, initialWethWei);
  await setUsdcBalance(publicClient, address, initialUsdcUnits);
  await sendAndMine(publicClient, walletClient, chain, privateKey, {
    to: ADDRESSES.weth,
    data: encodeFunctionData({ abi: wethAbi, functionName: "approve", args: [ADDRESSES.swapRouter, maxUint256] })
  });
  await sendAndMine(publicClient, walletClient, chain, privateKey, {
    to: ADDRESSES.weth,
    data: encodeFunctionData({ abi: wethAbi, functionName: "approve", args: [ADDRESSES.nonfungiblePositionManager, maxUint256] })
  });
  await sendAndMine(publicClient, walletClient, chain, privateKey, {
    to: ADDRESSES.usdc,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ADDRESSES.swapRouter, maxUint256] })
  });
  await sendAndMine(publicClient, walletClient, chain, privateKey, {
    to: ADDRESSES.usdc,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ADDRESSES.nonfungiblePositionManager, maxUint256] })
  });
}

export function snapshotForLog(snapshot: BalanceSnapshot) {
  return {
    eth: formatUnits(snapshot.ethWei, 18),
    weth: formatUnits(snapshot.wethWei, 18),
    usdc: formatUnits(snapshot.usdcUnits, 6)
  };
}
