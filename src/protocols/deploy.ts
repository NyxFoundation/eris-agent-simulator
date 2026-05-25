import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Abi, Address, Hex } from "viem";
import { mine } from "../chain.js";
import type { SimContext } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(here, `../../out/${name}.sol/${name}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `forge artifact missing: ${p}. Run \`npm run build:contracts\` (requires Foundry).`,
    );
  }
  const a = JSON.parse(readFileSync(p, "utf8"));
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
}

// forge アーティファクトを admin 鍵でデプロイ（--no-mining 対応で mine を挟む）。
export async function deployContract(
  ctx: SimContext,
  name: string,
  args: readonly unknown[] = [],
): Promise<Address> {
  const account = privateKeyToAccount(ctx.adminPk);
  const { abi, bytecode } = artifact(name);
  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    args: args as never,
    account,
    chain: ctx.chain,
  });
  await mine(ctx.publicClient);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy failed`);
  return receipt.contractAddress;
}
