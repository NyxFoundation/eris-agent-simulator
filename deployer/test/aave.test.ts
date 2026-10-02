import { describe, it, expect } from "vitest";
import type { Abi, Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve } from "../src/erc20.js";
import {
  aaveDeployment,
  getProto,
  expectRevert,
} from "./support.js";

const dep = accounts.deployer;
// An address with no role: not the deployer, not a seeded LP.
const STRANGER = "0x00000000000000000000000000000000feedbeef" as Address;

const a = getProto<{
  pool: Address;
  poolDataProvider: Address;
  faucet: Address;
  tokens: Record<string, Address>;
}>("aaveV3");

// Aave's own test market is closed (issue #190). @aave/deploy-v3 lists reserves on its own test
// tokens and deploys a Faucet for them; the competition never uses either, but the Pool is shared
// and the Aave score sums every reserve in it. So: only the deployer can mint, and the Pool refuses
// the tokens however they were obtained. (These tests used to supply and borrow on exactly these
// reserves -- the shared-reserve suite below is the one that exercises the market.)
describe.skipIf(!a)("Aave V3 vendor test market", () => {
  const poolAbi = (): Abi => aaveDeployment("Pool-Implementation").abi;
  const faucet = () => aaveDeployment("Faucet-Aave");

  it("the Faucet is permissioned and refuses a stranger", async () => {
    expect(
      await publicClient.readContract({
        address: faucet().address,
        abi: faucet().abi,
        functionName: "isPermissioned",
      }),
    ).toBe(true);
    await expectRevert(
      publicClient.simulateContract({
        address: faucet().address,
        abi: faucet().abi,
        functionName: "mint",
        args: [a!.tokens.USDC, STRANGER, 1n],
        account: STRANGER,
      }),
      "Faucet.mint(stranger)",
    );
  });

  it("every vendor reserve is inactive", async () => {
    const dp = aaveDeployment("PoolDataProvider-Aave");
    for (const [key, asset] of Object.entries(a!.tokens)) {
      const cfg = (await publicClient.readContract({
        address: a!.poolDataProvider,
        abi: dp.abi,
        functionName: "getReserveConfigurationData",
        args: [asset],
      })) as readonly unknown[];
      expect(cfg[8], `${key} isActive`).toBe(false);
    }
  });

  it("the Pool refuses a supply of a vendor token, even one the deployer minted", async () => {
    const token = a!.tokens.USDC;
    const amount = 1_000n * 10n ** 6n;
    // The deployer owns the Faucet, so it can still mint -- which is what makes this the check that
    // the Pool side is closed independently of the Faucet.
    const h = await deployerWallet.writeContract({
      address: faucet().address,
      abi: faucet().abi,
      functionName: "mint",
      args: [token, dep.address, amount],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    await approve(token, a!.pool, amount);
    await expectRevert(
      publicClient.simulateContract({
        address: a!.pool,
        abi: poolAbi(),
        functionName: "supply",
        args: [token, amount, dep.address, 0],
        account: dep,
      }),
      "supply(vendor USDC)",
    );
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
