/**
 * deploy.ts: 参加者コントラクトのデプロイヘルパ（ADR 0015 §1）。
 *
 * venue のデプロイは環境の仕事（deployer/）。ここは flash-arb executor のような
 * 「参加者が自分の鍵で自分のコントラクトを立てる」ためのヘルパ。forge artifact
 * （out/<Name>.sol/<Name>.json）は sdk の readForgeArtifact で読む（既定 repo ルートの
 * out/、提出 bundle 等レイアウトが違う場合は ERIS_FORGE_OUT で上書き）。
 */
import type { Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readForgeArtifact } from "@eris/sdk/forge.js";

// 自分の鍵でコントラクトをデプロイし、デプロイ先アドレスを返す（receipt 待ち）。
export async function deployArtifact(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  privateKey: Hex;
  name: string;
  args?: unknown[];
  priorityFeeWei?: bigint;
}): Promise<Address> {
  const account = privateKeyToAccount(opts.privateKey);
  const { abi, bytecode } = readForgeArtifact(opts.name);
  const block = await opts.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const tip = opts.priorityFeeWei ?? 1_000_000_000n;
  const hash = await opts.walletClient.deployContract({
    abi,
    bytecode,
    args: (opts.args ?? []) as never,
    account,
    chain: opts.chain,
    maxFeePerGas: baseFee * 2n + tip,
    maxPriorityFeePerGas: tip,
  });
  const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress)
    throw new Error(`deploy of ${opts.name} failed (no contractAddress)`);
  return receipt.contractAddress;
}
