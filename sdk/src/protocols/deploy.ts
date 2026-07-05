import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { mine } from "../chain.js";
import { readForgeArtifact } from "../forge.js";
import type { SimContext } from "./types.js";

// Deploy a forge artifact with the admin key (mines in between to support --no-mining).
export async function deployContract(
  ctx: SimContext,
  name: string,
  args: readonly unknown[] = [],
): Promise<Address> {
  const account = privateKeyToAccount(ctx.adminPk);
  const { abi, bytecode } = readForgeArtifact(name);
  // Set fees explicitly to avoid the fee estimate falling below the next block's baseFee and stalling the tx under --no-mining.
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    args: args as never,
    account,
    chain: ctx.chain,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(ctx.publicClient);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy failed`);
  return receipt.contractAddress;
}
