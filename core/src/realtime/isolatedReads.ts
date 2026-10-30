// Reads whose gas the agent being read controls, kept out of the shared Multicall3.
//
// The scorer folds every venue's reads at a cross-section into one `publicClient.multicall`, which
// viem cuts into ~1 KB chunks of `aggregate3`, each one `eth_call` under the node's default gas (the
// block gas limit, 30M). Inside a chunk each inner CALL gets 63/64 of what is left. So a read that
// one agent can make arbitrarily expensive -- `MockLSTVault.accountSummaryAt` walks every request
// the owner ever made -- takes ~29.5M of the chunk and leaves ~0.5M for whatever is listed after
// it: other agents' positions, and at stage 0 the fair price, whose failure refuses the whole
// boundary. Measured on anvil 1.5.1 (30M block limit), the LST-only chunk survived -- 24 honest
// `accountSummaryAt` reads at ~10k gas each fit in the remainder at every request count from 3,000
// to 3,300 -- but that is a margin, not a guarantee: a chunk that also holds a heavier read (a GMX
// Reader call, a Curve quote) after the bloated one has nothing to run on.
//
// A read marked `isolatedGas` is therefore issued alone, one `eth_call` capped at that gas
// (sdk/src/untrustedRead.ts). Its failure is undefined -- the shape every staged valuation already
// treats as "read failed" -- and touches nothing else. The live scorer and the post-run sweep both
// go through readValueSnapshotAtBlock, so they split the same reads the same way and
// `interval_series_agreement` keeps comparing like with like.
//
// No wall-clock deadline (untrustedRead's 1 s backstop is off): a timeout is the node's speed, not
// the chain's state, and a read that timed out live but not in the sweep would make the two series
// disagree for a reason neither of them measured. The gas cap is what bounds the work.
import type { PublicClient } from "viem";
import { readUntrustedBatch } from "@eris/sdk/untrustedRead.js";

export type MaybeIsolated = {
  address: `0x${string}`;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous ABIs
  abi: any;
  functionName: string;
  args?: readonly unknown[];
  isolatedGas?: bigint;
};

/**
 * Results in the order of `contracts`: the unmarked reads through `viaMulticall` (in their
 * relative order), each marked read through `isolated`. `undefined` is a failed read either way.
 */
export async function splitIsolatedReads<C extends MaybeIsolated>(
  contracts: readonly C[],
  viaMulticall: (shared: C[]) => Promise<unknown[]>,
  isolated: (alone: C[]) => Promise<unknown[]>,
): Promise<unknown[]> {
  const sharedIdx: number[] = [];
  const aloneIdx: number[] = [];
  contracts.forEach((c, i) =>
    (c.isolatedGas !== undefined ? aloneIdx : sharedIdx).push(i),
  );
  if (aloneIdx.length === 0) return viaMulticall([...contracts]);
  const [shared, alone] = await Promise.all([
    sharedIdx.length > 0
      ? viaMulticall(sharedIdx.map((i) => contracts[i]))
      : Promise.resolve([]),
    isolated(aloneIdx.map((i) => contracts[i])),
  ]);
  const out = new Array<unknown>(contracts.length);
  sharedIdx.forEach((i, k) => (out[i] = shared[k]));
  aloneIdx.forEach((i, k) => (out[i] = alone[k]));
  return out;
}

/** One gas-capped `eth_call` per read, at `blockNumber`. A failure is undefined. */
export async function readIsolated(
  publicClient: PublicClient,
  reads: readonly MaybeIsolated[],
  blockNumber: bigint,
): Promise<unknown[]> {
  // Grouped by cap so each group is one batch (a read has exactly one cap; in practice all share it).
  const out = new Array<unknown>(reads.length);
  const byGas = new Map<bigint, number[]>();
  reads.forEach((r, i) => {
    const gas = r.isolatedGas ?? 0n;
    byGas.set(gas, [...(byGas.get(gas) ?? []), i]);
  });
  await Promise.all(
    [...byGas].map(async ([gas, idx]) => {
      const results = await readUntrustedBatch(
        publicClient,
        idx.map((i) => {
          const { isolatedGas: _, ...read } = reads[i];
          return read;
        }),
        { blockNumber, gas, timeoutMs: 0 },
      );
      idx.forEach((i, k) => (out[i] = results[k].value));
    }),
  );
  return out;
}
