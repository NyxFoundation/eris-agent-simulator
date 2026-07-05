// Flash arb demo (GitHub #3). Used by the coordinator only when ERIS_FLASH_ARB=1.
// The nonce-0 deploy from a fixed deployer makes the FlashArb address deterministic,
// so the agent can compute the same value with getContractAddress (no env injection). Off by default.
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { mine, setEthBalance } from "@eris/sdk/chain.js";
import { AAVE, BALANCER, TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import {
  FLASH_ARB_ADDRESS,
  FLASH_DEPLOYER_ADDRESS,
  FLASH_DEPLOYER_KEY,
} from "@eris/sdk/wellKnown.js";

// The deterministic addresses (contract shared with agents) are canonically defined in sdk/src/wellKnown.ts.
export { FLASH_ARB_ADDRESS, FLASH_DEPLOYER_ADDRESS, FLASH_DEPLOYER_KEY };

// Deploy FlashArb from the fixed deployer (at nonce 0). Once, during the setup phase.
export async function deployFlashArb(ctx: SimContext): Promise<Address> {
  const account = privateKeyToAccount(FLASH_DEPLOYER_KEY);
  await setEthBalance(
    ctx.publicClient,
    FLASH_DEPLOYER_ADDRESS,
    1_000_000_000_000_000_000n,
  );
  const { abi, bytecode } = readForgeArtifact("FlashArb");
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    args: [
      AAVE.Pool,
      UNISWAP.swapRouter,
      BALANCER.vault,
      BALANCER.poolId,
      TOKENS.WETH.address,
      TOKENS.USDC.address,
      UNISWAP.fee,
    ] as never,
    account,
    chain: ctx.chain,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await mine(ctx.publicClient);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("FlashArb deploy failed");
  if (
    receipt.contractAddress.toLowerCase() !== FLASH_ARB_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      `FlashArb address mismatch: ${receipt.contractAddress} != ${FLASH_ARB_ADDRESS}`,
    );
  }
  return receipt.contractAddress;
}
