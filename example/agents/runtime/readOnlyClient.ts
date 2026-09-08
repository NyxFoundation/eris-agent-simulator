import { createPublicClient, custom, type PublicClient } from "viem";

// Guard the transport, not just client methods: viem actions and request() use the same path.
// This is an API boundary, not a sandbox for participant-authored Node programs.
export function readOnlyClient(client: PublicClient): PublicClient {
  return createPublicClient({
    chain: client.chain,
    batch: client.batch,
    transport: custom(
      {
        request(args) {
          if (
            !/^(eth_|net_|web3_)/.test(args.method) ||
            /^(eth_send|eth_sign|eth_accounts$)/.test(args.method)
          ) {
            throw new Error(
              `strategy RPC is read-only: ${args.method}; send actions through ctx.submit()`,
            );
          }
          return client.request(args);
        },
      },
      { retryCount: 0 },
    ),
  });
}
