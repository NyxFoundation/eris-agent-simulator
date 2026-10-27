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
/// Pinning is not by itself a fix for anvil's mid-mine read race: asked for the head block (by tag,
/// number or hash) while the next one is being mined, anvil can answer with the new block's state
/// under the previous block's header, and Aave's interest math then underflows on a reserve the new
/// block touched. Locally, with a small contract and light blocks, 1.5.1 showed it (10-18 per 1,000
/// blocks with the practice devnet's flags) and 1.7.1 / 1.8.1 / 1.8.3 did not. The practice chain's
/// own log (1.8.3, 2026-10-27) shows it anyway under the real load: `totalSupply()` of the USDC
/// variable debt token reverting with panic 0x11 at `latest` 5-6 times an hour, each logged while a
/// block was being mined, and each of those blocks carried an Aave Pool transaction. On 1.5.1 a retry
/// 100 ms later, by then a historical read, came back consistent in every case.
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
