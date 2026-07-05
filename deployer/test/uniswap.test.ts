import { describe, it, expect, beforeAll } from "vitest";
import type { Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../src/clients.js";
import { anvilChain } from "../src/config.js";
import { waitTx } from "../src/util.js";
import { approve, balanceOf } from "../src/erc20.js";
import {
  uniAbi,
  getProto,
  tokenAddr,
  expectApprox,
  expectRevert,
  deadline,
} from "./support.js";

const dep = accounts.deployer;
const FEE = 3000;
const ONE_WETH = 10n ** 18n;

const u = getProto<{
  swapRouter: Address;
  quoterV2: Address;
  positionManager: Address;
}>("uniswapV3");

describe.skipIf(!u)("Uniswap V3", () => {
  const weth = () => tokenAddr("WETH");
  const usdc = () => tokenAddr("USDC");

  let quotedOut: bigint;

  beforeAll(async () => {
    const { result } = await publicClient.simulateContract({
      address: u!.quoterV2,
      abi: uniAbi("quoterV2"),
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: weth(),
          tokenOut: usdc(),
          amountIn: ONE_WETH,
          fee: FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
      account: dep,
    });
    quotedOut = (result as readonly unknown[])[0] as bigint;
  });

  // A: quantitative --------------------------------------------------------
  it("quote is in a reasonable price band (1 WETH ~= 2700-3000 USDC)", () => {
    expect(quotedOut).toBeGreaterThan(2_700n * 10n ** 6n);
    expect(quotedOut).toBeLessThanOrEqual(3_000n * 10n ** 6n);
  });

  it("actual swap output matches the quote within +/-0.5% (WETH->USDC)", async () => {
    await approve(weth(), u!.swapRouter, ONE_WETH);
    const before = await balanceOf(usdc(), dep.address);
    const h = await deployerWallet.writeContract({
      address: u!.swapRouter,
      abi: uniAbi("swapRouter"),
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: weth(),
          tokenOut: usdc(),
          fee: FEE,
          recipient: dep.address,
          deadline: deadline(),
          amountIn: ONE_WETH,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const gained = (await balanceOf(usdc(), dep.address)) - before;
    expect(gained).toBeGreaterThan(0n);
    expectApprox(gained, quotedOut, 50, "swap output vs quote");
  });

  // C: negative ------------------------------------------------------------
  it("swap with an oversized amountOutMinimum reverts", async () => {
    await expectRevert(
      publicClient.simulateContract({
        address: u!.swapRouter,
        abi: uniAbi("swapRouter"),
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: weth(),
            tokenOut: usdc(),
            fee: FEE,
            recipient: dep.address,
            deadline: deadline(),
            amountIn: ONE_WETH,
            amountOutMinimum: quotedOut * 2n, // unreachable
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: dep,
      }),
      "exactInputSingle(oversized minOut)",
    );
  });

  // B: round trip ----------------------------------------------------------
  it("reverse swap (USDC->WETH) increases WETH", async () => {
    const amountIn = 1_000n * 10n ** 6n; // 1000 USDC
    await approve(usdc(), u!.swapRouter, amountIn);
    const before = await balanceOf(weth(), dep.address);
    const h = await deployerWallet.writeContract({
      address: u!.swapRouter,
      abi: uniAbi("swapRouter"),
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: usdc(),
          tokenOut: weth(),
          fee: FEE,
          recipient: dep.address,
          deadline: deadline(),
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    const gained = (await balanceOf(weth(), dep.address)) - before;
    expect(gained).toBeGreaterThan(0n);
  });

  // B: lifecycle (withdraw a liquidity position) ---------------------------
  it("decreaseLiquidity + collect on a position returns tokens", async () => {
    const pmAbi = uniAbi("posManager");
    const tokenId = (await publicClient.readContract({
      address: u!.positionManager,
      abi: pmAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [dep.address, 0n],
    })) as bigint;

    const pos = (await publicClient.readContract({
      address: u!.positionManager,
      abi: pmAbi,
      functionName: "positions",
      args: [tokenId],
    })) as readonly unknown[];
    const liquidity = pos[7] as bigint; // liquidity in the positions struct
    expect(liquidity).toBeGreaterThan(0n);

    const beforeW = await balanceOf(weth(), dep.address);
    const beforeU = await balanceOf(usdc(), dep.address);

    const dec = await deployerWallet.writeContract({
      address: u!.positionManager,
      abi: pmAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId,
          liquidity: liquidity / 2n,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: deadline(),
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(dec);

    const MAX_U128 = (1n << 128n) - 1n;
    const col = await deployerWallet.writeContract({
      address: u!.positionManager,
      abi: pmAbi,
      functionName: "collect",
      args: [
        {
          tokenId,
          recipient: dep.address,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        },
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(col);

    const afterW = await balanceOf(weth(), dep.address);
    const afterU = await balanceOf(usdc(), dep.address);
    // The withdrawn principal increases WETH and/or USDC (usually both)
    expect(afterW > beforeW || afterU > beforeU).toBe(true);
  });
});
