import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { publicClient } from "../src/clients.js";
import { getRegistry } from "../src/registry.js";
import {
  ZERO,
  uniAbi,
  vaultAbi,
  weightedPoolAbi,
  curveAbi,
  aaveDeployment,
  gmxDeployment,
  getProto,
  tokenAddr,
  isAddress,
  sameAddr,
} from "./support.js";

const FEE = 3000;

/** Recursively walk deployments.json to collect address strings (ZERO excluded) */
// Keys to exclude from the bytecode check. GMX markets are not deployed contracts
// but a list of token references, and a synthetic market's indexToken intentionally
// uses a virtual address (a price-feed key) with no code, so it is excluded.
const SKIP_KEYS = new Set(["markets"]);

function collectAddresses(node: unknown, acc: Map<string, Address>): void {
  if (isAddress(node)) {
    if (node.toLowerCase() !== ZERO.toLowerCase())
      acc.set(node.toLowerCase(), node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectAddresses(v, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      collectAddresses(v, acc);
    }
  }
}

describe("deployment health (E)", () => {
  it("every address in deployments.json has bytecode", async () => {
    const reg = getRegistry();
    const addrs = new Map<string, Address>();
    collectAddresses(reg.tokens, addrs);
    collectAddresses(reg.protocols, addrs);
    expect(addrs.size).toBeGreaterThan(0);

    const empty: string[] = [];
    for (const addr of addrs.values()) {
      const code = await publicClient.getBytecode({ address: addr });
      if (!code || code === "0x") empty.push(addr);
    }
    expect(empty, `no bytecode: ${empty.join(", ")}`).toEqual([]);
  });

  describe("Uniswap V3 wiring", () => {
    const u = getProto<{
      factory: Address;
      positionManager: Address;
      swapRouter: Address;
      wethUsdcPool: Address;
    }>("uniswapV3");
    it.skipIf(!u)(
      "PositionManager / SwapRouter point to the factory",
      async () => {
        const pmFactory = await publicClient.readContract({
          address: u!.positionManager,
          abi: uniAbi("posManager"),
          functionName: "factory",
        });
        const srFactory = await publicClient.readContract({
          address: u!.swapRouter,
          abi: uniAbi("swapRouter"),
          functionName: "factory",
        });
        expect(sameAddr(pmFactory as string, u!.factory)).toBe(true);
        expect(sameAddr(srFactory as string, u!.factory)).toBe(true);
      },
    );
    it.skipIf(!u)("factory.getPool returns the seeded pool", async () => {
      const pool = (await publicClient.readContract({
        address: u!.factory,
        abi: uniAbi("factory"),
        functionName: "getPool",
        args: [tokenAddr("WETH"), tokenAddr("USDC"), FEE],
      })) as Address;
      expect(pool).not.toBe(ZERO);
      expect(sameAddr(pool, u!.wethUsdcPool)).toBe(true);
    });
  });

  describe("Balancer V2 wiring", () => {
    const b = getProto<{
      authorizer: Address;
      vault: Address;
      wethUsdcPool: Address;
      wethUsdcPoolId: Hex;
    }>("balancerV2");
    it.skipIf(!b)(
      "Vault.getAuthorizer / Pool.getVault are consistent",
      async () => {
        const auth = await publicClient.readContract({
          address: b!.vault,
          abi: vaultAbi(),
          functionName: "getAuthorizer",
        });
        const poolVault = await publicClient.readContract({
          address: b!.wethUsdcPool,
          abi: weightedPoolAbi(),
          functionName: "getVault",
        });
        expect(sameAddr(auth as string, b!.authorizer)).toBe(true);
        expect(sameAddr(poolVault as string, b!.vault)).toBe(true);
      },
    );
    it.skipIf(!b)(
      "Vault.getPoolTokens returns 2 tokens with balances > 0",
      async () => {
        const res = (await publicClient.readContract({
          address: b!.vault,
          abi: vaultAbi(),
          functionName: "getPoolTokens",
          args: [b!.wethUsdcPoolId],
        })) as readonly [Address[], bigint[], bigint];
        expect(res[0].length).toBe(2);
        expect(res[1].every((x) => x > 0n)).toBe(true);
      },
    );
  });

  describe("Aave V3 wiring", () => {
    const a = getProto<{ pool: Address; aaveOracle: Address }>("aaveV3");
    it.skipIf(!a)("PoolAddressesProvider points to pool/oracle", async () => {
      const provider = aaveDeployment("PoolAddressesProvider-Aave");
      const pool = await publicClient.readContract({
        address: provider.address,
        abi: provider.abi,
        functionName: "getPool",
      });
      const oracle = await publicClient.readContract({
        address: provider.address,
        abi: provider.abi,
        functionName: "getPriceOracle",
      });
      expect(sameAddr(pool as string, a!.pool)).toBe(true);
      expect(sameAddr(oracle as string, a!.aaveOracle)).toBe(true);
    });
    it.skipIf(!a)("AaveOracle.getAssetPrice > 0", async () => {
      const oracleArt = aaveDeployment("AaveOracle-Aave");
      const tokens = getProto<{ tokens: Record<string, Address> }>(
        "aaveV3",
      )!.tokens;
      const price = (await publicClient.readContract({
        address: oracleArt.address,
        abi: oracleArt.abi,
        functionName: "getAssetPrice",
        args: [tokens.USDC],
      })) as bigint;
      expect(price).toBeGreaterThan(0n);
    });
  });

  describe("Curve wiring", () => {
    const c = getProto<{ factory: Address; usdcDaiPool: Address }>("curve");
    it.skipIf(!c)(
      "pool is registered in the factory and coins match",
      async () => {
        const fAbi = curveAbi("CurveStableSwapFactoryNG");
        const count = (await publicClient.readContract({
          address: c!.factory,
          abi: fAbi,
          functionName: "pool_count",
        })) as bigint;
        expect(count).toBeGreaterThanOrEqual(1n);
        const pool = (await publicClient.readContract({
          address: c!.factory,
          abi: fAbi,
          functionName: "pool_list",
          args: [0n],
        })) as Address;
        expect(sameAddr(pool, c!.usdcDaiPool)).toBe(true);

        const pAbi = curveAbi("CurveStableSwapNG");
        const coin0 = (await publicClient.readContract({
          address: c!.usdcDaiPool,
          abi: pAbi,
          functionName: "coins",
          args: [0n],
        })) as Address;
        const coin1 = (await publicClient.readContract({
          address: c!.usdcDaiPool,
          abi: pAbi,
          functionName: "coins",
          args: [1n],
        })) as Address;
        expect(sameAddr(coin0, tokenAddr("USDC"))).toBe(true);
        expect(sameAddr(coin1, tokenAddr("DAI"))).toBe(true);
      },
    );
  });

  describe("GMX V2 wiring", () => {
    const g = getProto<{
      Reader: Address;
      DataStore: Address;
      marketCount?: number;
    }>("gmxV2");
    it.skipIf(!g)(
      "Reader.getMarkets count matches the recorded value",
      async () => {
        const reader = gmxDeployment("Reader");
        const markets = (await publicClient.readContract({
          address: g!.Reader,
          abi: reader.abi,
          functionName: "getMarkets",
          args: [g!.DataStore, 0n, 100n],
        })) as readonly unknown[];
        expect(markets.length).toBeGreaterThan(0);
        if (typeof g!.marketCount === "number")
          expect(markets.length).toBe(g!.marketCount);
      },
    );
  });
});
