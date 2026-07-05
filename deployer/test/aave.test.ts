import { describe, it, expect, beforeAll } from "vitest";
import { maxUint256, type Abi, type Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve, balanceOf } from "../src/erc20.js";
import {
  aaveDeployment,
  getProto,
  expectApprox,
  expectRevert,
} from "./support.js";

const dep = accounts.deployer;
const VARIABLE = 2n; // interestRateMode

const a = getProto<{
  pool: Address;
  poolDataProvider: Address;
  faucet: Address;
  tokens: Record<string, Address>;
  aTokens: Record<string, Address>;
}>("aaveV3");

describe.skipIf(!a)("Aave V3", () => {
  const poolAbi = (): Abi => aaveDeployment("Pool-Implementation").abi;
  const pool = () => a!.pool;

  // Test amounts (within faucet limits, independent of seed)
  const DAI = () => a!.tokens.DAI;
  const WBTC = () => a!.tokens.WBTC;
  const DAI_LIQ = 9_000n * 10n ** 18n;
  const WBTC_COL = 1n * 10n ** 8n; // 1 WBTC
  const DAI_BORROW = 500n * 10n ** 18n;

  let daiDebtToken: Address;

  async function faucetMint(token: Address, amount: bigint) {
    const faucet = aaveDeployment("Faucet-Aave");
    const h = await deployerWallet.writeContract({
      address: faucet.address,
      abi: faucet.abi,
      functionName: "mint",
      args: [token, dep.address, amount],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }

  async function supply(token: Address, amount: bigint) {
    await faucetMint(token, amount);
    await approve(token, pool(), amount);
    const h = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi(),
      functionName: "supply",
      args: [token, amount, dep.address, 0],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }

  async function accountData(): Promise<readonly bigint[]> {
    return (await publicClient.readContract({
      address: pool(),
      abi: poolAbi(),
      functionName: "getUserAccountData",
      args: [dep.address],
    })) as readonly bigint[];
  }

  beforeAll(async () => {
    const dp = aaveDeployment("PoolDataProvider-Aave");
    const res = (await publicClient.readContract({
      address: a!.poolDataProvider,
      abi: dp.abi,
      functionName: "getReserveTokensAddresses",
      args: [DAI()],
    })) as readonly [Address, Address, Address];
    daiDebtToken = res[2]; // variableDebtToken
  });

  // A: supply increases aToken balance by the supplied amount ---------------
  it("supply makes aToken balance roughly match the supplied amount", async () => {
    await supply(DAI(), DAI_LIQ);
    await supply(WBTC(), WBTC_COL);
    const aDai = await balanceOf(a!.aTokens.DAI, dep.address);
    const aWbtc = await balanceOf(a!.aTokens.WBTC, dep.address);
    expectApprox(aDai, DAI_LIQ, 50, "aDAI balance");
    expectApprox(aWbtc, WBTC_COL, 50, "aWBTC balance");
  });

  // A: borrow increases variableDebt by the borrowed amount + HF stays healthy
  it("borrow makes variableDebt roughly match the borrowed amount and HF > 1", async () => {
    const debtBefore = await balanceOf(daiDebtToken, dep.address);
    const h = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi(),
      functionName: "borrow",
      args: [DAI(), DAI_BORROW, VARIABLE, 0, dep.address],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const debtGained =
      (await balanceOf(daiDebtToken, dep.address)) - debtBefore;
    expectApprox(debtGained, DAI_BORROW, 50, "DAI variableDebt delta");

    const acct = await accountData();
    expect(acct[1]).toBeGreaterThan(0n); // totalDebtBase
    expect(acct[5]).toBeGreaterThan(10n ** 18n); // healthFactor > 1.0
  });

  // C: negative (borrowing beyond collateral reverts) -----------------------
  it("borrowing far beyond collateral reverts", async () => {
    await expectRevert(
      publicClient.simulateContract({
        address: pool(),
        abi: poolAbi(),
        functionName: "borrow",
        args: [DAI(), 100_000_000n * 10n ** 18n, VARIABLE, 0, dep.address],
        account: dep,
      }),
      "borrow(oversized)",
    );
  });

  // B: lifecycle (repay -> withdraw) ----------------------------------------
  it("repay brings DAI debt to ~0 and withdraw returns WBTC collateral", async () => {
    // Top up repayment funds and repay in full
    await faucetMint(DAI(), DAI_BORROW * 2n);
    await approve(DAI(), pool(), maxUint256);
    const repay = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi(),
      functionName: "repay",
      args: [DAI(), maxUint256, VARIABLE, dep.address],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(repay);
    const daiDebt = await balanceOf(daiDebtToken, dep.address);
    expect(daiDebt).toBeLessThan(10n ** 15n); // ~= 0 (less than 0.001 DAI)

    const wbtcBefore = await balanceOf(WBTC(), dep.address);
    const withdraw = await deployerWallet.writeContract({
      address: pool(),
      abi: poolAbi(),
      functionName: "withdraw",
      args: [WBTC(), WBTC_COL, dep.address],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(withdraw);
    expect(await balanceOf(WBTC(), dep.address)).toBeGreaterThan(wbtcBefore);
  });
});

// ---------------------------------------------------------------------------
// Reserves for the shared mock tokens (WETH/USDC). Shared tokens that can span
// protocols, registered into Aave as reserves after the fact (registerSharedReserves).
// ---------------------------------------------------------------------------
const sr = getProto<{
  pool: Address;
  poolDataProvider: Address;
  aaveOracle: Address;
  sharedReserves?: {
    tokens: Record<string, Address>;
    aTokens: Record<string, Address>;
    variableDebtTokens: Record<string, Address>;
  };
}>("aaveV3");

describe.skipIf(!sr?.sharedReserves)("Aave V3 shared reserves", () => {
  const shared = sr!.sharedReserves!;
  const pdpAbi = (): Abi => aaveDeployment("PoolDataProvider-Aave").abi;
  const oracleAbi = (): Abi => aaveDeployment("AaveOracle-Aave").abi;

  it("shared WETH/USDC registered as reserves with collateral + borrowing enabled", async () => {
    for (const key of ["WETH", "USDC"] as const) {
      const asset = shared.tokens[key];
      const cfg = (await publicClient.readContract({
        address: sr!.poolDataProvider,
        abi: pdpAbi(),
        functionName: "getReserveConfigurationData",
        args: [asset],
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
      // [decimals, ltv, lt, bonus, factor, usageAsCollateral, borrowing, stable, active, frozen]
      expect(cfg[1], `${key} ltv`).toBeGreaterThan(0n);
      expect(cfg[5], `${key} usageAsCollateral`).toBe(true);
      expect(cfg[6], `${key} borrowing`).toBe(true);
      expect(cfg[8], `${key} isActive`).toBe(true);
      expect(cfg[9], `${key} isFrozen`).toBe(false);
    }
  });

  it("shared reserve aToken/variableDebtToken match the registry", async () => {
    for (const key of ["WETH", "USDC"] as const) {
      const toks = (await publicClient.readContract({
        address: sr!.poolDataProvider,
        abi: pdpAbi(),
        functionName: "getReserveTokensAddresses",
        args: [shared.tokens[key]],
      })) as readonly [Address, Address, Address];
      expect(toks[0].toLowerCase()).toBe(shared.aTokens[key].toLowerCase());
      expect(toks[2].toLowerCase()).toBe(
        shared.variableDebtTokens[key].toLowerCase(),
      );
      expect(toks[0]).not.toBe("0x0000000000000000000000000000000000000000");
    }
  });

  it("AaveOracle returns a positive price for shared WETH/USDC", async () => {
    for (const key of ["WETH", "USDC"] as const) {
      const price = (await publicClient.readContract({
        address: sr!.aaveOracle,
        abi: oracleAbi(),
        functionName: "getAssetPrice",
        args: [shared.tokens[key]],
      })) as bigint;
      expect(price, `${key} price`).toBeGreaterThan(0n);
    }
  });
});
