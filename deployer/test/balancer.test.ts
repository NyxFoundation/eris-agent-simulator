import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve, balanceOf } from "../src/erc20.js";
import {
  vaultAbi,
  getProto,
  tokenAddr,
  expectApprox,
  expectRevert,
  deadline,
} from "./support.js";

const dep = accounts.deployer;
const ONE_WETH = 10n ** 18n;

const b = getProto<{
  vault: Address;
  wethUsdcPool: Address;
  wethUsdcPoolId: Hex;
}>("balancerV2");

describe.skipIf(!b)("Balancer V2", () => {
  const vault = () => b!.vault;
  const poolId = () => b!.wethUsdcPoolId;
  const weth = () => tokenAddr("WETH");
  const usdc = () => tokenAddr("USDC");

  const funds = () => ({
    sender: dep.address,
    fromInternalBalance: false,
    recipient: dep.address,
    toInternalBalance: false,
  });

  // A: quantitative (queryBatchSwap estimate vs actual swap) -----------------
  it("queryBatchSwap estimate matches actual swap within +/-0.5% (WETH->USDC)", async () => {
    const assets = [weth(), usdc()] as Address[];
    const { result } = await publicClient.simulateContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "queryBatchSwap",
      args: [
        0, // GIVEN_IN
        [
          {
            poolId: poolId(),
            assetInIndex: 0n,
            assetOutIndex: 1n,
            amount: ONE_WETH,
            userData: "0x" as Hex,
          },
        ],
        assets,
        funds(),
      ],
      account: dep,
    });
    const deltas = result as readonly bigint[];
    // deltas[1] is the amount leaving the vault, so it is negative. Expected USDC out = -deltas[1]
    const expectedOut = -deltas[1];
    expect(expectedOut).toBeGreaterThan(0n);

    await approve(weth(), vault(), ONE_WETH);
    const before = await balanceOf(usdc(), dep.address);
    const h = await deployerWallet.writeContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "swap",
      args: [
        {
          poolId: poolId(),
          kind: 0,
          assetIn: weth(),
          assetOut: usdc(),
          amount: ONE_WETH,
          userData: "0x" as Hex,
        },
        funds(),
        0n,
        deadline(),
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const gained = (await balanceOf(usdc(), dep.address)) - before;
    expect(gained).toBeGreaterThan(0n);
    expectApprox(gained, expectedOut, 50, "swap output vs queryBatchSwap");
  });

  // C: negative ------------------------------------------------------------
  it("swap with an oversized limit (minOut) reverts", async () => {
    await expectRevert(
      publicClient.simulateContract({
        address: vault(),
        abi: vaultAbi(),
        functionName: "swap",
        args: [
          {
            poolId: poolId(),
            kind: 0,
            assetIn: weth(),
            assetOut: usdc(),
            amount: ONE_WETH,
            userData: "0x" as Hex,
          },
          funds(),
          1_000_000n * 10n ** 6n, // unreachable minOut
          deadline(),
        ],
        account: dep,
      }),
      "swap(oversized limit)",
    );
  });

  // B: lifecycle (withdraw liquidity via exitPool) -------------------------
  it("exitPool reduces BPT and returns tokens", async () => {
    // Fetch the assets in registration order (ascending) from the vault
    const pt = (await publicClient.readContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "getPoolTokens",
      args: [poolId()],
    })) as readonly [Address[], bigint[], bigint];
    const assets = pt[0];

    const bptBefore = await balanceOf(b!.wethUsdcPool, dep.address);
    expect(bptBefore).toBeGreaterThan(0n);
    const wethBefore = await balanceOf(weth(), dep.address);
    const usdcBefore = await balanceOf(usdc(), dep.address);

    // EXACT_BPT_IN_FOR_TOKENS_OUT (kind=1): userData = abi.encode(uint256 kind, uint256 bptAmountIn)
    const bptIn = bptBefore / 10n; // 10%
    const userData = encodeAbiParameters(
      parseAbiParameters("uint256, uint256"),
      [1n, bptIn],
    );
    const h = await deployerWallet.writeContract({
      address: vault(),
      abi: vaultAbi(),
      functionName: "exitPool",
      args: [
        poolId(),
        dep.address,
        dep.address,
        {
          assets,
          minAmountsOut: assets.map(() => 0n),
          userData,
          toInternalBalance: false,
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);

    expect(await balanceOf(b!.wethUsdcPool, dep.address)).toBeLessThan(
      bptBefore,
    );
    const wethAfter = await balanceOf(weth(), dep.address);
    const usdcAfter = await balanceOf(usdc(), dep.address);
    expect(wethAfter > wethBefore && usdcAfter > usdcBefore).toBe(true);
  });
});
