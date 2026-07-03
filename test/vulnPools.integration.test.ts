// ADR 0014 の load-bearing 機構を bare anvil 上で検証する統合テスト。
// 純関数テスト（vulnEvents.test.ts）では Solidity の実行（skim / honest / dry-run 検出）を
// 覆えないため、実チェーンで契約挙動を確かめる。foundry(anvil) が無い環境では自動 skip し、
// `npm test` を green に保つ（他テストは pure なので anvil 非依存）。
//
// 検証項目:
//   1. SimpleAMM: getAmountOut == swap 実出力（honest）。
//   2. RiggedAMM: getAmountOut は honest（餌）だが、swap は amountIn>rugThreshold で skim する。
//   3. RiggedAMM: amountIn<rugThreshold の小さな probe は skim されず通る（＝full-size dry-run が要る理由）。
//   4. verifyContract: 実サイズ dry-run で rigged=unsafe / safe=safe を決定論的に判定する。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vulnAmmAbi } from "../example/agents/lib/vulnAbi.js";
import { verifyContract } from "../example/agents/lib/verifyContract.js";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8577; // 通常の 8545 と衝突しない検証専用ポート
const RPC = `http://127.0.0.1:${PORT}`;
// anvil default account 0
const PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const anvilChain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(
    readFileSync(resolve(ROOT, `out/${name}.sol/${name}.json`), "utf8"),
  );
  return {
    abi: a.abi as Abi,
    bytecode: (a.bytecode?.object ?? a.bytecode) as Hex,
  };
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
      pub
        .getChainId()
        .then(() => "ok" as const)
        .catch(() => "retry" as const),
      failed,
    ]);
    if (raced === "ok") return child;
    if (raced === null) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  return null;
}

test("ADR 0014 vuln pools: skim / honest / dry-run 検出（要 anvil）", async (t) => {
  if (
    !existsSync(resolve(ROOT, "out/VulnPoolFactory.sol/VulnPoolFactory.json"))
  ) {
    t.skip("run `npm run build:contracts` first");
    return;
  }
  const anvil = await startAnvil();
  if (!anvil) {
    t.skip("anvil unavailable (foundry 未インストール等)");
    return;
  }
  try {
    const account = privateKeyToAccount(PK);
    const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
    const wallet = createWalletClient({
      account,
      chain: anvilChain,
      transport: http(RPC),
    });

    const deploy = async (
      name: string,
      args: readonly unknown[],
    ): Promise<Address> => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({
        abi,
        bytecode,
        args: args as never,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (!rc.contractAddress) throw new Error(`${name} deploy failed`);
      return rc.contractAddress;
    };
    const send = async (to: Address, abi: Abi, fn: string, args: unknown[]) => {
      const hash = await wallet.writeContract({
        address: to,
        abi,
        functionName: fn,
        args: args as never,
      });
      await pub.waitForTransactionReceipt({ hash });
    };

    const erc20 = artifact("MockERC20").abi;
    const base = await deploy("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const usdc = await deploy("MockERC20", ["USD Coin", "USDC", 6]);
    const factory = await deploy("VulnPoolFactory", []);
    const factoryAbi = artifact("VulnPoolFactory").abi;

    const feeBps = 30;
    const rugThreshold = 1_000_000_000n; // 1,000 USDC（6 桁）
    const rugBps = 5000; // 50% skim

    // createSimplePool / createRiggedPool（PoolCreated から pool アドレスを取得）
    const createPool = async (
      fn: string,
      args: unknown[],
    ): Promise<Address> => {
      const hash = await wallet.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: fn,
        args: args as never,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      // PoolCreated(pool indexed, token0 indexed, token1 indexed, feeBps)
      const log = rc.logs.find(
        (l) => l.address.toLowerCase() === factory.toLowerCase(),
      );
      if (!log) throw new Error("no PoolCreated log");
      return `0x${log.topics[1]!.slice(26)}` as Address;
    };
    const simple = await createPool("createSimplePool", [base, usdc, feeBps]);
    const rigged = await createPool("createRiggedPool", [
      base,
      usdc,
      feeBps,
      rugThreshold,
      rugBps,
    ]);

    // 両プールに同一 reserve を積む（price 3000。deep なのでスリッページ極小）。
    const reserveBase = 1000n * 10n ** 18n; // 1000 WETH
    const reserveUsdc = 3_000_000n * 10n ** 6n; // 3,000,000 USDC
    for (const pool of [simple, rigged]) {
      await send(base, erc20, "mint", [pool, reserveBase]);
      await send(usdc, erc20, "mint", [pool, reserveUsdc]);
    }

    // trader（= account）に USDC を配り、両プールへ approve。
    const trader = account.address;
    await send(usdc, erc20, "mint", [trader, 100_000n * 10n ** 6n]);
    for (const pool of [simple, rigged]) {
      await send(usdc, erc20, "approve", [pool, 2n ** 255n]);
    }

    const bigIn = 5_000_000_000n; // 5,000 USDC（> rugThreshold）
    const smallIn = 500_000_000n; // 500 USDC（< rugThreshold）

    const quote = async (pool: Address, amountIn: bigint): Promise<bigint> =>
      (await pub.readContract({
        address: pool,
        abi: vulnAmmAbi,
        functionName: "getAmountOut",
        args: [amountIn, usdc],
      })) as bigint;
    const simSwap = async (
      pool: Address,
      amountIn: bigint,
    ): Promise<bigint> => {
      const { result } = await pub.simulateContract({
        address: pool,
        abi: vulnAmmAbi,
        functionName: "swap",
        args: [amountIn, 0n, usdc, trader],
        account,
      });
      return result as bigint;
    };

    // 1) getAmountOut は両プールで一致（RiggedAMM の view は honest = 餌）。
    const qSimpleBig = await quote(simple, bigIn);
    const qRiggedBig = await quote(rigged, bigIn);
    assert.equal(qRiggedBig, qSimpleBig, "rigged getAmountOut must be honest");
    assert.ok(qSimpleBig > 0n);

    // 2) SimpleAMM: swap 実出力 == 見積り（honest）。
    const simpleSim = await simSwap(simple, bigIn);
    assert.equal(simpleSim, qSimpleBig, "simple swap must match quote");

    // 3) RiggedAMM: 実サイズ（>閾値）swap は skim され見積りを大きく下回る。
    const riggedSimBig = await simSwap(rigged, bigIn);
    assert.ok(
      riggedSimBig < (qRiggedBig * 6000n) / 10000n,
      `rigged big swap must skim: sim=${riggedSimBig} quote=${qRiggedBig}`,
    );
    // 概ね (1-rugBps) 倍
    assert.ok(
      riggedSimBig <= (qRiggedBig * (10000n - BigInt(rugBps))) / 10000n + 2n,
    );

    // 4) RiggedAMM: 小さな probe（<閾値）は skim されず通る（full-size dry-run が要る理由）。
    const qRiggedSmall = await quote(rigged, smallIn);
    const riggedSimSmall = await simSwap(rigged, smallIn);
    assert.equal(
      riggedSimSmall,
      qRiggedSmall,
      "small probe under threshold must not skim",
    );

    // 5) verifyContract: 実サイズ dry-run で rigged=unsafe / safe=safe を判定（disclosure 無し=unverified）。
    const vSimple = await verifyContract({
      publicClient: pub,
      pool: simple,
      tokenIn: usdc,
      amountIn: bigIn,
      trader,
      llmMode: "0",
    });
    assert.equal(vSimple.status, "safe", `simple verify: ${vSimple.reason}`);
    assert.equal(vSimple.checks.dryRun, "ok");

    const vRigged = await verifyContract({
      publicClient: pub,
      pool: rigged,
      tokenIn: usdc,
      amountIn: bigIn,
      trader,
      llmMode: "0",
    });
    assert.equal(vRigged.status, "unsafe", `rigged verify: ${vRigged.reason}`);
    assert.equal(vRigged.checks.dryRun, "skim");
  } finally {
    anvil.kill();
  }
});
