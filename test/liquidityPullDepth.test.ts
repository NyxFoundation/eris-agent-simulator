// What a liquidity pull actually does to a venue, measured on chain (issue #52 phase 3).
//
// The event makes two claims that the unit tests cannot check, because both are properties of the
// deployed pools rather than of the schedule:
//
//   1. **It does not move the price.** The withdrawal is proportional, so a small trade should
//      execute at the same price with half the book gone. If this were false the event would be
//      handing every agent a risk-free arbitrage, which is precisely what ADR 0007 forbids.
//   2. **It does raise the cost of size.** A large trade should execute materially worse. If this
//      were false the crash regime would still be a "larger opportunity" regime -- the defect issue
//      #52 exists to fix.
//
// Run against the distributed state dump (ADR 0016) on its own anvil, and skipped when either anvil
// or the dump is absent, so `npm test` stays green in CI.
//
// The measured numbers are recorded in the commit and on the issue. They are anvil numbers: the
// competition runs on a real chain, so treat the *ratios* as the finding and re-measure the
// absolutes once the platform is settled.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(import.meta.dirname, "..");
const STATE = resolve(ROOT, "backtest/state/venues-state.json");
const PORT = 8578; // its own port, away from sim (8545) and backtest (8547)
const RPC = `http://127.0.0.1:${PORT}`;
// anvil default account 0 = the deployer that owns the seeded liquidity (ADR 0016 §4)
const OWNER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const anvilChain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

async function startAnvil(): Promise<ChildProcess | null> {
  if (!existsSync(STATE)) return null;
  let child: ChildProcess;
  try {
    child = spawn(
      "anvil",
      ["--load-state", STATE, "--port", String(PORT), "--silent"],
      { stdio: "ignore" },
    );
  } catch {
    return null;
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        }),
      });
      if (res.ok) return child;
    } catch {
      // not up yet
    }
  }
  child.kill();
  return null;
}

test("a liquidity pull raises the cost of size without moving the price", async (t) => {
  const anvil = await startAnvil();
  if (!anvil) {
    t.skip(
      "needs anvil and backtest/state/venues-state.json (npm run gen:state-dump)",
    );
    return;
  }
  // The address overlay is read at import time, so it has to be set before the SDK is loaded.
  process.env.ERIS_LOCAL_DEPLOY = "1";
  const { TOKENS, UNISWAP, BALANCER } = await import("@eris/sdk/constants.js");
  const { quoterV2Abi, balancerQueriesAbi, curveTwocryptoLiquidityAbi } =
    await import("@eris/sdk/abis.js");
  const { marketFor } = await import("@eris/sdk/markets.js");
  const { discoverPullPositions, buildWithdraw, readShare, readPoolDepth } =
    await import("../core/src/realtime/liquidityVenues.js");
  const { curveTricryptoAbi } = await import("@eris/sdk/abis.js");

  const publicClient = createPublicClient({
    chain: anvilChain,
    transport: http(RPC),
  });
  const walletClient = createWalletClient({
    chain: anvilChain,
    transport: http(RPC),
  });
  const owner = privateKeyToAccount(OWNER_PK).address;
  const ctx = {
    publicClient,
    walletClient,
    chain: anvilChain,
  } as unknown as Parameters<typeof discoverPullPositions>[0];

  // Executable price for a given size, per venue. Small = the price everyone sees; large = the
  // price someone taking real size actually gets.
  const SMALL = 10n ** 16n; // 0.01 WETH
  const LARGE = 10n * 10n ** 18n; // 10 WETH
  const weth = TOKENS.WETH.address;
  const usdc = TOKENS.USDC.address;

  async function quote(venue: string, amountIn: bigint): Promise<number> {
    if (venue === "uniswap") {
      const leg = marketFor("uniswap", "WETH")!.uniswap!;
      const { result } = await publicClient.simulateContract({
        address: UNISWAP.quoterV2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: weth,
            tokenOut: usdc,
            amountIn,
            fee: leg.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return Number(result[0]) / 1e6 / (Number(amountIn) / 1e18);
    }
    if (venue === "balancer") {
      const poolId = marketFor("balancer", "WETH")!.balancer!.poolId;
      const { result } = await publicClient.simulateContract({
        address: BALANCER.queries,
        abi: balancerQueriesAbi,
        functionName: "querySwap",
        args: [
          {
            poolId,
            kind: 0,
            assetIn: weth,
            assetOut: usdc,
            amount: amountIn,
            userData: "0x",
          },
          {
            sender: owner,
            fromInternalBalance: false,
            recipient: owner,
            toInternalBalance: false,
          },
        ],
      });
      return Number(result) / 1e6 / (Number(amountIn) / 1e18);
    }
    const leg = marketFor("curve", "WETH")!.curve!;
    const out = (await publicClient.readContract({
      address: leg.pool,
      abi: curveTricryptoAbi,
      functionName: "get_dy",
      args: [BigInt(leg.baseIndex), BigInt(leg.quoteIndex), amountIn],
    })) as bigint;
    return Number(out) / 1e6 / (Number(amountIn) / 1e18);
  }

  const venues = ["uniswap", "balancer", "curve"] as const;
  const { positions, misses } = await discoverPullPositions(
    ctx,
    [...venues],
    ["WETH"],
    owner,
  );
  assert.equal(misses.length, 0, `unowned venues: ${misses.join(", ")}`);

  const before: Record<string, { small: number; large: number }> = {};
  for (const v of venues)
    before[v] = { small: await quote(v, SMALL), large: await quote(v, LARGE) };

  // Withdraw half of every book, the way the stress event does.
  for (const pos of positions) {
    const share = await readShare(ctx, pos, owner);
    const call = await buildWithdraw(
      ctx,
      pos,
      owner,
      share / 2n,
      BigInt(Math.floor(Date.now() / 1000) + 3600),
    );
    const hash = await walletClient.sendTransaction({
      account: privateKeyToAccount(OWNER_PK),
      chain: anvilChain,
      to: call.to,
      data: call.data,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${pos.venue} withdraw reverted`);
    const after = await readPoolDepth(ctx, pos);
    assert.ok(after !== undefined, `${pos.venue} depth unreadable`);
  }

  const lines: string[] = [];
  for (const v of venues) {
    const small = await quote(v, SMALL);
    const large = await quote(v, LARGE);
    const priceMoveBps = Math.abs(small / before[v].small - 1) * 10_000;
    const costBefore = (1 - before[v].large / before[v].small) * 10_000;
    const costAfter = (1 - large / small) * 10_000;
    lines.push(
      `${v.padEnd(9)} price move ${priceMoveBps.toFixed(2)}bps | ` +
        `cost of 10 WETH ${costBefore.toFixed(1)}bps -> ${costAfter.toFixed(1)}bps ` +
        `(x${(costAfter / costBefore).toFixed(2)})`,
    );

    // 1. Half the book gone must not reprice the venue. A proportional withdrawal returns both
    //    sides at the current ratio, so anything beyond rounding here means the event is handing
    //    out an arbitrage rather than imposing a constraint.
    assert.ok(
      priceMoveBps < 1,
      `${v}: pull moved the executable price by ${priceMoveBps.toFixed(2)}bps`,
    );
    // 2. ...and it must actually cost more to trade size. Equal cost would mean the regime still
    //    only asks whether a gap exists.
    assert.ok(
      costAfter > costBefore * 1.5,
      `${v}: cost of size barely moved (${costBefore.toFixed(1)} -> ${costAfter.toFixed(1)}bps)`,
    );
  }
  console.log(
    `\n[#52 phase 3] 50% pull, measured on the state dump:\n${lines.join("\n")}\n`,
  );

  anvil.kill();
});
