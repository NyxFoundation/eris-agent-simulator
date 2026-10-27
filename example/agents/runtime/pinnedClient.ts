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
/// whenever one was mined during the dozen-odd reads, and a retry (read.ts, servingLastGood) would
/// answer for a later block than the rest of the observation. Pinned, a retry answers for this one.
///
/// Pinning is not a fix for the read race of anvil 1.5.1: asked for the head block (by tag, number
/// or hash) while the next one is being mined, that version can answer with the new block's state
/// under the previous block's header (10-18 per 1,000 blocks with the practice devnet's flags; a
/// retry 100 ms later, by then a historical read, came back consistent in every case). 1.7.1, 1.8.1
/// and 1.8.3 showed none in the same test (0 of ~500,000 calls, 3 runs each), and the practice chain
/// pins 1.8.3 (infra/monitoring/docker-compose.yml).
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
