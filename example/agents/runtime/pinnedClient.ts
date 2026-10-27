import { createPublicClient, custom, numberToHex, type PublicClient } from "viem";

// Where each state read carries its block parameter.
const BLOCK_PARAM_INDEX: Record<string, number> = {
  eth_call: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getStorageAt: 2,
  eth_getTransactionCount: 1,
};

/// A client whose state reads at `latest` (or with no block at all) are read at `block` instead.
///
/// One block's observation is read at that block. Read at `latest`, it straddled the next block
/// whenever one was mined during the dozen-odd reads. Pinning does not by itself stop anvil's
/// mid-mine race: asked for the head block (by tag, number or hash) while the next one is being
/// mined, anvil can answer with the new block's state under the previous block's header (measured,
/// anvil 1.5.1 with the practice devnet's flags: 4-9 of ~260,000 calls over 1,000 blocks, pinned or
/// not). What pinning buys there is the retry: once the next block is mined, the same request is a
/// historical read with one state and one header, and the retry gets this block's answer rather than
/// the next block's (read.ts, servingLastGood).
///
/// Any other tag (`pending`, `safe`, a number or a hash) is passed through as the caller wrote it.
export function pinnedClient(client: PublicClient, block: number | bigint): PublicClient {
  const tag = numberToHex(BigInt(block));
  return createPublicClient({
    chain: client.chain,
    batch: client.batch,
    transport: custom(
      {
        request(args) {
          return client.request(pinRequest(args, tag) as Parameters<PublicClient["request"]>[0]);
        },
      },
      { retryCount: 0 },
    ),
  });
}

export function pinRequest<T extends { method: string; params?: unknown }>(
  args: T,
  tag: `0x${string}`,
): T {
  const i = BLOCK_PARAM_INDEX[args.method];
  if (i === undefined || !Array.isArray(args.params) || args.params.length < i)
    return args;
  const given = args.params[i];
  if (given !== undefined && given !== null && given !== "latest") return args;
  const params = [...args.params];
  params[i] = tag;
  return { ...args, params };
}
