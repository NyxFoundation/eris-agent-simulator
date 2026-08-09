// Issue #38 phase 3: the LST listed as Aave collateral, on a real chain.
//
// Phase 3's requirement is environmental -- "register LST as an Aave reserve and enable ETH
// borrowing against it" -- so this checks the market rather than a strategy: that the reserve
// exists with the parameters an LST warrants, that ETH can actually be borrowed against it, that
// the LST itself cannot be borrowed, and that a slash reaches the health factor once the oracle
// follows. The last one is the liquidation cascade in miniature.
//
// It needs the full local deploy (Aave takes minutes to stand up via hardhat-deploy), so unlike the
// vault test it does not spawn its own chain: it runs against an already-deployed anvil and skips
// when there is not one. `cd deployer && npm run deploy -- --keep-fresh` provides it, and
// ERIS_LOCAL_DEPLOY=1 opts in.
import test from "node:test";
import assert from "node:assert/strict";
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
import { AAVE, LST, TOKENS } from "@eris/sdk/constants.js";
import { lstVaultAbi } from "@eris/sdk/abis.js";
import { aaveOracleAbi, aavePoolAbi } from "@eris/sdk/protocols/aave.js";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const WAD = 10n ** 18n;
// anvil default account 3, which no roster in this repo hands to an agent.
const PK =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;
// The simulation's admin, which the deploy registers as a vault operator (keccak256("eris-role:admin")).
const OPERATOR_PK =
  "0x3975d4550834ac20d287d0ca1dbcbdc2dc5724d61d25acd5570b87f370bc7d8a" as Hex;

const anvilChain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const erc20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function deposit() payable",
]);
const dataProviderAbi = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
]);

async function healthFactor(
  pub: ReturnType<typeof createPublicClient>,
  user: Address,
): Promise<number> {
  const data = (await pub.readContract({
    address: AAVE.Pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [user],
  })) as readonly bigint[];
  return Number(data[5]) / 1e18;
}

test("LST as Aave collateral: listing, borrowing ETH against it, and a slash reaching the health factor (requires a local deploy)", async (t) => {
  if (process.env.ERIS_LOCAL_DEPLOY !== "1") {
    t.skip("set ERIS_LOCAL_DEPLOY=1 against a local deploy to run this");
    return;
  }
  if (!LST?.aaveAToken) {
    t.skip("this deployment has no LST reserve");
    return;
  }
  const lst = LST;
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
  try {
    await pub.getChainId();
  } catch {
    t.skip(`no chain at ${RPC}`);
    return;
  }

  const account = privateKeyToAccount(PK);
  const operator = privateKeyToAccount(OPERATOR_PK);
  const wallet = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(RPC),
  });
  const testClient = createTestClient({
    chain: anvilChain,
    mode: "anvil",
    transport: http(RPC),
  });

  // Snapshot first: this deployment may be in use, and the test stakes, borrows and slashes.
  const snapshot = await testClient.snapshot();
  try {
    await testClient.setAutomine(true);
    const send = async (
      to: Address,
      // biome-ignore lint/suspicious/noExplicitAny: a handful of heterogeneous ABIs
      abi: any,
      functionName: string,
      args: unknown[] = [],
      value?: bigint,
    ) => {
      const hash = await wallet.writeContract({
        address: to,
        abi,
        functionName,
        args: args as never,
        value,
        account,
        chain: anvilChain,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      assert.equal(rc.status, "success", `${functionName} reverted`);
    };

    // ---- 1. listed with parameters stated for an LST, and collateral only ----
    const cfg = (await pub.readContract({
      address: AAVE.PoolDataProvider,
      abi: dataProviderAbi,
      functionName: "getReserveConfigurationData",
      args: [lst.lstToken],
    })) as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    assert.equal(cfg[1], 7000n, "LTV");
    assert.equal(cfg[2], 7500n, "liquidation threshold");
    assert.ok(cfg[5], "must be usable as collateral");
    assert.ok(
      !cfg[6],
      "borrowing the LST itself stays disabled: the point is borrowing ETH against it",
    );

    // ---- 2. priced as WETH x the redemption rate, not as WETH ----
    const rate = (await pub.readContract({
      address: lst.vault,
      abi: lstVaultAbi,
      functionName: "stEthPerToken",
    })) as bigint;
    const [lstPrice, wethPrice] = (await Promise.all([
      pub.readContract({
        address: AAVE.AaveOracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [lst.lstToken],
      }),
      pub.readContract({
        address: AAVE.AaveOracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [TOKENS.WETH.address],
      }),
    ])) as [bigint, bigint];
    assert.ok(lstPrice > 0n, "the LST has no Aave price");
    const impliedRate = Number(lstPrice) / Number(wethPrice);
    assert.ok(
      Math.abs(impliedRate - Number(rate) / 1e18) < 0.02,
      `Aave prices the LST at ${impliedRate.toFixed(4)} x WETH, the vault says ${(Number(rate) / 1e18).toFixed(4)}`,
    );

    // ---- 3. stake, post as collateral, borrow WETH against it ----
    await send(TOKENS.WETH.address, erc20, "deposit", [], 10n * WAD);
    await send(TOKENS.WETH.address, erc20, "approve", [lst.vault, 10n * WAD]);
    await send(lst.vault, lstVaultAbi, "deposit", [5n * WAD, account.address]);
    const shares = (await pub.readContract({
      address: lst.vault,
      abi: erc20,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    assert.ok(shares > 0n, "staking minted nothing");

    await send(lst.vault, erc20, "approve", [AAVE.Pool, shares]);
    await send(AAVE.Pool, aavePoolAbi, "supply", [
      lst.lstToken,
      shares,
      account.address,
      0,
    ]);
    const posted = (await pub.readContract({
      address: AAVE.Pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [account.address],
    })) as readonly bigint[];
    assert.ok(posted[0] > 0n, "the LST was not counted as collateral");
    assert.ok(posted[2] > 0n, "posting LST gave no borrowing power");

    // One turn of leveraged staking: borrow a quarter of the headroom as WETH.
    const borrowWei = (posted[2] * WAD) / wethPrice / 4n;
    assert.ok(borrowWei > 0n, "headroom too small to borrow against");
    await send(AAVE.Pool, aavePoolAbi, "borrow", [
      TOKENS.WETH.address,
      borrowWei,
      2n,
      0,
      account.address,
    ]);
    const hfBefore = await healthFactor(pub, account.address);
    assert.ok(
      hfBefore > 1 && hfBefore < 100,
      `expected a real levered position, got HF ${hfBefore}`,
    );

    // ---- 4. a slash reaches the health factor, but only once the oracle follows ----
    // The vault is cut first and Aave keeps the old price until the environment writes the new one.
    // Both halves are asserted, because the lag is the mechanism: the position stays stale-healthy
    // for exactly as long as the oracle is stale, and then a whole cohort turns liquidatable at once.
    await testClient.setBalance({ address: operator.address, value: WAD });
    const opWallet = createWalletClient({
      account: operator,
      chain: anvilChain,
      transport: http(RPC),
    });
    const slashHash = await opWallet.writeContract({
      address: lst.vault,
      abi: lstVaultAbi,
      functionName: "slash",
      args: [2000n], // 20%: far above a run's calibration, to move the health factor visibly
      account: operator,
      chain: anvilChain,
    });
    const slashRc = await pub.waitForTransactionReceipt({ hash: slashHash });
    assert.equal(slashRc.status, "success", "slash reverted");

    const hfStale = await healthFactor(pub, account.address);
    assert.ok(
      Math.abs(hfStale - hfBefore) < 0.02,
      `the health factor moved before the oracle did (${hfBefore} -> ${hfStale}), so there is no lag`,
    );

    // The environment's per-block write lands: same aggregator, price rebuilt from the new rate.
    const newRate = (await pub.readContract({
      address: lst.vault,
      abi: lstVaultAbi,
      functionName: "stEthPerToken",
    })) as bigint;
    const aggregator = (await pub.readContract({
      address: AAVE.AaveOracle,
      abi: aaveOracleAbi,
      functionName: "getSourceOfAsset",
      args: [lst.lstToken],
    })) as Address;
    const newPrice = (wethPrice * newRate) / WAD;
    await testClient.setStorageAt({
      address: aggregator,
      index: "0x0",
      value: `0x${newPrice.toString(16).padStart(64, "0")}` as Hex,
    });

    const hfAfter = await healthFactor(pub, account.address);
    assert.ok(
      hfAfter < hfBefore * 0.9,
      `the slash never reached the health factor (${hfBefore} -> ${hfAfter})`,
    );
  } finally {
    await testClient.revert({ id: snapshot });
  }
});
