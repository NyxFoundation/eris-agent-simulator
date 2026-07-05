/**
 * deploy.ts: helper to deploy participant contracts (ADR 0015 §1).
 *
 * Deploying venues is the environment's job (deployer/). This is a helper for a participant
 * to stand up their own contract with their own key, like the flash-arb executor. The forge
 * artifact (out/<Name>.sol/<Name>.json) is read via sdk's readForgeArtifact (default out/ at the
 * repo root; override with ERIS_FORGE_OUT when the layout differs, e.g. a submission bundle).
 */
import type { Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readForgeArtifact } from "@eris/sdk/forge.js";

// Deploy a contract with your own key and return the deployed address (waits for the receipt).
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
