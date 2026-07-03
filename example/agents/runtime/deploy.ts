/**
 * deploy.ts: 参加者コントラクトのデプロイヘルパ（ADR 0015 §1）。
 *
 * venue のデプロイは環境の仕事（deployer/）。ここは flash-arb executor のような
 * 「参加者が自分の鍵で自分のコントラクトを立てる」ためのヘルパ。forge artifact
 * （out/<Name>.sol/<Name>.json）を読み、自分のウォレットでデプロイする。
 * artifact の場所は既定で repo ルートの out/（ERIS_FORGE_OUT で上書き可）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Abi,
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const outDir = process.env.ERIS_FORGE_OUT ?? resolve(here, "../../../out");
  const p = resolve(outDir, `${name}.sol/${name}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `forge artifact missing: ${p}. Run \`npm run build:contracts\` (または ERIS_FORGE_OUT を指定).`,
    );
  }
  const a = JSON.parse(readFileSync(p, "utf8"));
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
}

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
  const { abi, bytecode } = artifact(opts.name);
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
