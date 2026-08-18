import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { fundWallet, makeChain } from "@eris/sdk/chain.js";

// ADR 0019 §6: `funding.ethWei` has to be the agent's actual native balance. `fundWallet` used to add
// GAS_BUFFER_WEI (5 ETH) to every wallet unconditionally, so the "USDC-only" rosters were handing each
// agent 105 ETH while their YAML said `wethWei: "0"`, and the endowment the ADR proposes (1 ETH) would
// have landed as 6 ETH = 15.2% of the portfolio in unchosen β instead of 2.9%. Environment wallets keep
// the buffer (a flow bot that runs dry removes market activity from everyone; the admin USDC top-up in
// protocols/aave.ts passes ethWei=0 and pays for the grant out of it).

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ONE_ETH = 1_000_000_000_000_000_000n;

function stubChain() {
  const setBalances: bigint[] = [];
  const sentValues: bigint[] = [];
  const client = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }) => {
      if (method === "anvil_setBalance")
        setBalances.push(BigInt(params[1] as string));
      return null;
    },
    getBlock: async () => ({ baseFeePerGas: 0n }),
    waitForTransactionReceipt: async () => ({}),
  } as unknown as PublicClient;
  const wallet = {
    sendTransaction: async (tx: { to: Address; value?: bigint }) => {
      sentValues.push(tx.value ?? 0n);
      return `0x${"11".repeat(32)}` as Hex;
    },
  } as unknown as WalletClient;
  const chain = {} as ReturnType<typeof makeChain>;
  return { client, wallet, chain, setBalances, sentValues };
}

test("fundWallet: environment wallets keep the 5 ETH gas headroom", async () => {
  const s = stubChain();
  await fundWallet(s.client, s.wallet, s.chain, PK, ONE_ETH, 0n, 0n);
  assert.deepEqual(s.setBalances, [6n * ONE_ETH]);
});

test("fundWallet: gasBufferWei=0 makes funding.ethWei the whole balance (scored wallets)", async () => {
  const s = stubChain();
  await fundWallet(
    s.client,
    s.wallet,
    s.chain,
    PK,
    ONE_ETH,
    0n,
    0n,
    undefined,
    0n,
  );
  assert.deepEqual(s.setBalances, [ONE_ETH]);
});

test("fundWallet: base inventory is funded on top of the reserve, not out of it", async () => {
  // A roster that asks for WETH (the lst regime does) must still hold its `ethWei` reserve after the
  // wrap has spent `wethWei`, or the agent is stranded with inventory it cannot trade.
  const s = stubChain();
  await fundWallet(
    s.client,
    s.wallet,
    s.chain,
    PK,
    ONE_ETH,
    20n * ONE_ETH,
    0n,
    undefined,
    0n,
  );
  assert.deepEqual(s.setBalances, [21n * ONE_ETH]);
  assert.deepEqual(s.sentValues, [20n * ONE_ETH]);
});
