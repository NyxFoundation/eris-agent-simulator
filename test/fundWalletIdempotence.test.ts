// What funding a wallet twice does, measured rather than assumed.
//
// `fundWallet` grants five things and does not grant them the same way. Four are cheatcodes that
// *assign* a balance; WETH is the one the holder has to obtain by a transaction it signs itself
// (`WETH9.deposit()`), so it *adds*. Calling the function again with the same arguments therefore
// leaves four balances where they were and doubles the fifth.
//
// That asymmetry is invisible from the signature -- every argument is "the amount this wallet should
// have" -- and it cost a run: a supplementary call added to raise one wallet's quote balance passed
// `config.flowWethWei` along with it for symmetry, and every gap-closing wallet started the epoch on
// 300 WETH instead of 150. It was found by replaying an epoch and noticing an inventory that had no
// business moving, which is a slow way to learn a calling convention.
//
// `fundAddress` -- the path for a wallet whose key the environment does not hold -- grants WETH with
// the same cheatcode as everything else, because only the holder could call `deposit`. So the two
// funding paths disagree about exactly one token, and a reader of either one cannot tell.
//
// Both facts are pinned below. If someone makes `fundWallet` assign WETH too, this fails and says
// what else to look at: the callers that currently rely on the second call adding.
//
// Self-contained on bare anvil: the two tokens are put at the registry's addresses with setCode, so
// no deploy and no state dump are needed. Auto-skips where foundry is absent, like the other
// integration tests here.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8579; // its own port, so a run here cannot disturb a sim on 8545 or a backtest on 8547
const RPC = `http://127.0.0.1:${PORT}`;
const WAD = 10n ** 18n;
// anvil default account 0: the wallet being funded. Its key is public, which is the point -- the
// environment holds this kind of key for its own wallets (ADR 0021 §2 is about the other kind).
const PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const anvilChain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

function deployedBytecode(name: string): Hex | null {
  const path = resolve(ROOT, `deployer/out/${name}.sol/${name}.json`);
  if (!existsSync(path)) return null;
  const a = JSON.parse(readFileSync(path, "utf8")) as {
    deployedBytecode?: { object?: string } | string;
  };
  const d = a.deployedBytecode;
  const hex = typeof d === "string" ? d : d?.object;
  return hex && hex.length > 2 ? (hex as Hex) : null;
}

async function startAnvil(): Promise<ChildProcess | null> {
  let child: ChildProcess;
  try {
    child = spawn("anvil", ["--port", String(PORT), "--silent"], {
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  const failed = new Promise<null>((res) => {
    child.once("error", () => res(null));
    child.once("exit", () => res(null));
  });
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    const raced = await Promise.race([
      pub.getChainId().then(() => "ok" as const).catch(() => "retry" as const),
      failed,
    ]);
    if (raced === "ok") return child;
    if (raced === null) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  return null;
}

test("funding a wallet twice: four balances hold, WETH doubles (requires anvil)", async (t) => {
  const weth9 = deployedBytecode("WETH9");
  const mock = deployedBytecode("MockERC20");
  if (!weth9 || !mock)
    return t.skip("deployer artifacts missing: cd deployer && forge build");

  // Imported here: constants.ts freezes its address overlay when it is first evaluated, and
  // ERIS_LOCAL_DEPLOY above has to be set before that happens.
  const { TOKENS } = await import("../sdk/src/constants.js");
  const { isParStable } = await import("../sdk/src/stables.js");
  const { fundWallet, makeChain, activeStables } = await import(
    "../sdk/src/chain.js"
  );

  const anvil = await startAnvil();
  if (!anvil) return t.skip("anvil not available");
  t.after(() => anvil.kill());

  process.env.ANVIL_RPC_URL = RPC;
  const chain = makeChain(31337);
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
  const testClient = createTestClient({
    chain: anvilChain,
    mode: "anvil",
    transport: http(RPC),
  });
  const wallet = createWalletClient({
    chain: anvilChain,
    transport: http(RPC),
    account: privateKeyToAccount(PK),
  });

  // The registry's tokens, put where the registry says they are. WETH9 needs its real code for
  // `deposit()`; the rest only need somewhere for a balance to be written.
  const tokens: Address[] = [TOKENS.WETH.address];
  await testClient.setCode({ address: TOKENS.WETH.address, bytecode: weth9 });
  for (const t2 of activeStables())
    if (isParStable(t2)) {
      await testClient.setCode({ address: t2, bytecode: mock });
      tokens.push(t2);
    }
  const wbtc = TOKENS.WBTC?.address;
  if (wbtc) {
    await testClient.setCode({ address: wbtc, bytecode: mock });
    tokens.push(wbtc);
  }

  const me = privateKeyToAccount(PK).address;
  const ETH = 10n * WAD;
  const WETH_WEI = 150n * WAD;
  const USDC_UNITS = 450_000n * 10n ** 6n;
  const BASES: Record<string, bigint> = wbtc ? { WBTC: 75n * 10n ** 7n } : {};

  const read = async (): Promise<{ eth: bigint; by: Map<Address, bigint> }> => {
    const by = new Map<Address, bigint>();
    for (const token of tokens)
      by.set(
        token,
        (await pub.readContract({
          address: token,
          abi: erc20,
          functionName: "balanceOf",
          args: [me],
        })) as bigint,
      );
    return { eth: await pub.getBalance({ address: me }), by };
  };

  await fundWallet(pub, wallet, chain, PK, ETH, WETH_WEI, USDC_UNITS, BASES);
  const once = await read();
  await fundWallet(pub, wallet, chain, PK, ETH, WETH_WEI, USDC_UNITS, BASES);
  const twice = await read();

  assert.equal(
    twice.by.get(TOKENS.WETH.address),
    2n * WETH_WEI,
    "WETH is wrapped by the holder, so a second call adds a second 150 -- the reason a " +
      "supplementary fundWallet must pass 0 for it",
  );
  assert.equal(
    once.by.get(TOKENS.WETH.address),
    WETH_WEI,
    "and the first call is exact, so the doubling is the second call's doing",
  );
  for (const token of tokens) {
    if (token === TOKENS.WETH.address) continue;
    assert.equal(
      twice.by.get(token),
      once.by.get(token),
      `${token} is granted with a cheatcode, so funding again leaves it where it was`,
    );
  }
  // ETH is assigned too, but gas for the two `deposit` transactions comes out of it, so it is only
  // "the same" up to what those cost: what matters is that it did not accumulate.
  assert.ok(
    twice.eth <= once.eth + ETH / 100n,
    `ETH is assigned, not added (${once.eth} -> ${twice.eth})`,
  );
});

test("the no-key path grants WETH the same way as everything else (requires anvil)", async (t) => {
  // `fundAddress` cannot make the recipient sign `deposit`, so it deals WETH like any other token --
  // which makes it idempotent where `fundWallet` is not. Two functions with the same five arguments
  // and the same stated meaning, disagreeing about one of them.
  const weth9 = deployedBytecode("WETH9");
  const mock = deployedBytecode("MockERC20");
  if (!weth9 || !mock)
    return t.skip("deployer artifacts missing: cd deployer && forge build");

  const { TOKENS } = await import("../sdk/src/constants.js");
  const { fundAddress, makeChain } = await import("../sdk/src/chain.js");

  const anvil = await startAnvil();
  if (!anvil) return t.skip("anvil not available");
  t.after(() => anvil.kill());

  process.env.ANVIL_RPC_URL = RPC;
  const chain = makeChain(31337);
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
  const testClient = createTestClient({
    chain: anvilChain,
    mode: "anvil",
    transport: http(RPC),
  });
  const wallet = createWalletClient({
    chain: anvilChain,
    transport: http(RPC),
    account: privateKeyToAccount(PK),
  });
  await testClient.setCode({ address: TOKENS.WETH.address, bytecode: weth9 });

  // An address whose key nobody here holds, which is the whole point of this path.
  const them = "0x00000000000000000000000000000000000f1111" as Address;
  const WETH_WEI = 150n * WAD;
  const wethOf = async (): Promise<bigint> =>
    (await pub.readContract({
      address: TOKENS.WETH.address,
      abi: erc20,
      functionName: "balanceOf",
      args: [them],
    })) as bigint;

  await fundAddress(pub, wallet, chain, them, 10n * WAD, WETH_WEI, 0n, {});
  assert.equal(await wethOf(), WETH_WEI);
  await fundAddress(pub, wallet, chain, them, 10n * WAD, WETH_WEI, 0n, {});
  assert.equal(
    await wethOf(),
    WETH_WEI,
    "fundAddress deals WETH, so it is idempotent -- unlike fundWallet, which wraps it",
  );
});
