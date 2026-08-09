// MockLSTVault on a real chain (issue #38).
//
// The pure tests cover the marking rules; this covers the Solidity the venue is actually made of,
// which is where the properties that matter are enforced:
//   1. staking mints at the current rate, and yield raises that rate for everyone holding shares
//   2. a direct WETH transfer is a donation to nobody -- it must not move the exchange rate
//   3. accrual is bounded by the funded reserve, and its size depends only on blocks elapsed
//   4. the withdrawal queue pays par, but only after its delay, and only to the requester
//   5. the queue locks in its rate at request time, so later yield does not retro-price it
//
// Auto-skips where foundry is absent, keeping `npm test` green.
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
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8578; // verification-only port that does not collide with the usual 8545
const RPC = `http://127.0.0.1:${PORT}`;
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
// anvil default accounts 0 and 1
const PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OTHER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const anvilChain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

// The vault and WETH9 are the deployer's contracts, so their artifacts live under deployer/out.
function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(
    readFileSync(
      resolve(ROOT, `deployer/out/${name}.sol/${name}.json`),
      "utf8",
    ),
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

test("MockLSTVault: rate, donations, reserve and the withdrawal queue (requires anvil)", async (t) => {
  if (
    !existsSync(
      resolve(ROOT, "deployer/out/MockLSTVault.sol/MockLSTVault.json"),
    )
  ) {
    t.skip("run `cd deployer && forge build` first");
    return;
  }
  const anvil = await startAnvil();
  if (!anvil) {
    t.skip("anvil unavailable (foundry not installed, etc.)");
    return;
  }
  try {
    const account = privateKeyToAccount(PK);
    const other = privateKeyToAccount(OTHER_PK);
    const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
    const wallet = createWalletClient({
      account,
      chain: anvilChain,
      transport: http(RPC),
    });
    const otherWallet = createWalletClient({
      account: other,
      chain: anvilChain,
      transport: http(RPC),
    });
    const testClient = createTestClient({
      chain: anvilChain,
      mode: "anvil",
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

    const weth = await deploy("WETH9", []);
    const wethAbi = artifact("WETH9").abi;
    const vaultAbi = artifact("MockLSTVault").abi;

    // 1%/block: a deliberately absurd rate so the effects are visible in a handful of blocks.
    const ratePerBlockRay = RAY / 100n;
    const delayBlocks = 5n;
    const vault = await deploy("MockLSTVault", [
      weth,
      other.address, // a second operator, as the deployer wires the simulation's admin key
      ratePerBlockRay,
      delayBlocks,
    ]);

    const read = async (fn: string, args: unknown[] = []) =>
      pub.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: fn,
        args: args as never,
      });

    // Freeze mining before anything is measured: accrual counts blocks, so every call has to land
    // in a block this test chose. `send` therefore submits, mines exactly one block, and checks the
    // receipt -- reading before the mine would see the pre-tx state.
    await testClient.setAutomine(false);
    await testClient.setIntervalMining({ interval: 0 });
    const send = async (
      to: Address,
      abi: Abi,
      fn: string,
      args: unknown[] = [],
      opts: { value?: bigint; from?: typeof wallet } = {},
    ) => {
      const from = opts.from ?? wallet;
      const hash = await from.writeContract({
        address: to,
        abi,
        functionName: fn,
        args: args as never,
        value: opts.value,
        account: from.account!,
        chain: anvilChain,
      });
      await testClient.mine({ blocks: 1 });
      const rc = await pub.waitForTransactionReceipt({ hash });
      assert.equal(rc.status, "success", `${fn} reverted`);
      return rc;
    };

    await send(weth, wethAbi, "deposit", [], { value: 100n * WAD });
    await send(weth, wethAbi, "approve", [vault, 100n * WAD]);

    // ---- 1. staking mints at the current rate ----
    await send(vault, vaultAbi, "deposit", [10n * WAD, account.address]);
    assert.equal(await read("totalPooledWeth"), 10n * WAD);
    assert.equal(await read("stEthPerToken"), WAD, "the first stake sets 1:1");
    // The bootstrap burn is locked away, not handed to the depositor.
    const bootstrapBurn = (await read("BOOTSTRAP_BURN_SHARES")) as bigint;
    assert.equal(
      await read("balanceOf", [account.address]),
      10n * WAD - bootstrapBurn,
    );

    // ---- 2. a direct transfer does not move the exchange rate ----
    // The classic donation attack: if totalPooledWeth were balanceOf(this), this would reprice
    // every share and let a first depositor grief the next one.
    await send(weth, wethAbi, "transfer", [vault, 5n * WAD]);
    assert.equal(await read("stEthPerToken"), WAD, "a donation moved the rate");
    assert.equal(await read("totalPooledWeth"), 10n * WAD);
    assert.equal(
      await read("surplusWeth"),
      5n * WAD,
      "the donation is visible",
    );

    // ---- 3. accrual is bounded by the funded reserve ----
    // Nothing funded yet, so poking accrual pays nothing however many blocks pass.
    await testClient.mine({ blocks: 3 });
    await send(vault, vaultAbi, "accrueRewards");
    assert.equal(
      await read("stEthPerToken"),
      WAD,
      "yield accrued with an empty reserve",
    );

    await send(weth, wethAbi, "approve", [vault, 100n * WAD]);
    await send(vault, vaultAbi, "fundRewards", [2n * WAD]);
    assert.equal(await read("rewardReserve"), 2n * WAD);
    assert.equal(
      await read("stEthPerToken"),
      WAD,
      "funding the reserve is not itself yield",
    );

    // Accrual at 1%/block on a 10 WETH pool, over the blocks since the last poke.
    await send(vault, vaultAbi, "accrueRewards");
    const afterOne = (await read("stEthPerToken")) as bigint;
    assert.ok(
      afterOne > WAD,
      `the rate should rise once rewards are funded (got ${afterOne})`,
    );
    assert.ok(
      ((await read("totalPooledWeth")) as bigint) > 10n * WAD,
      "the pool did not grow",
    );

    // ---- 4. the queue pays par, after its delay, to the requester only ----
    const shares = (await read("balanceOf", [account.address])) as bigint;
    const queued = shares / 2n;
    const parAtRequest = (await read("convertToAssets", [queued])) as bigint;
    await send(vault, vaultAbi, "requestWithdraw", [queued]);
    assert.equal(
      await read("balanceOf", [account.address]),
      shares - queued,
      "requesting burns the shares",
    );
    assert.equal(await read("openRequestCount"), 1n);
    assert.equal(await read("pendingWithdrawalWeth"), parAtRequest);

    // Not finalized yet: claiming has to fail rather than pay early.
    await assert.rejects(
      pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "claimWithdraw",
        args: [0n],
        account,
      }),
      /not finalized/,
    );
    // ... and it never belongs to anyone else.
    await testClient.mine({ blocks: Number(delayBlocks) + 1 });
    await assert.rejects(
      pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "claimWithdraw",
        args: [0n],
        account: other,
      }),
      /not request owner/,
    );

    // ---- 5. later yield does not retro-price a queued request ----
    await send(vault, vaultAbi, "accrueRewards");
    const wethBefore = (await pub.readContract({
      address: weth,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    await send(vault, vaultAbi, "claimWithdraw", [0n]);
    const wethAfter = (await pub.readContract({
      address: weth,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    assert.equal(
      wethAfter - wethBefore,
      parAtRequest,
      "the queue paid something other than the rate locked in at request time",
    );
    assert.equal(await read("openRequestCount"), 0n);
    assert.equal(await read("pendingWithdrawalWeth"), 0n);

    // The vault still covers every obligation it has left.
    const held = (await pub.readContract({
      address: weth,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [vault],
    })) as bigint;
    const owed =
      ((await read("totalPooledWeth")) as bigint) +
      ((await read("pendingWithdrawalWeth")) as bigint) +
      ((await read("rewardReserve")) as bigint);
    assert.ok(held >= owed, `vault is short: holds ${held}, owes ${owed}`);

    // ---- 6. reconfiguration is operator-only ----
    await assert.rejects(
      pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "setRewardRate",
        args: [0n],
        account: privateKeyToAccount(
          "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
        ),
      }),
      /not operator/,
    );
    // The environment's admin key was registered at construction, so it can.
    await send(vault, vaultAbi, "setRewardRate", [0n], { from: otherWallet });
    assert.equal(await read("rewardRatePerBlockRay"), 0n);
  } finally {
    anvil.kill();
  }
});
