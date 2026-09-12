import type { AgentObservation } from "@eris/sdk/types.js";

export function pythonObservation(round = 1): AgentObservation {
  return {
    kind: "observation",
    runId: "python-test",
    round,
    blockNumber: String(round),
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 3000,
    oraclePrices: { wethUsd: 3000, usdcUsd: 1 },
    enabledProtocols: ["uniswap", "balancer", "curve"],
    balances: {
      ethWei: "1000000000000000000",
      wethWei: "2000000000000000000",
      usdcUnits: "9007199254740993000000",
    },
    inventory: { eth: 1, weth: 2, usdc: 10000, valueUsdc: 16000 },
    history: [],
    limits: {
      defaultPriorityFeePerGasWei: "1",
      maxPriorityFeePerGasWei: "100",
      defaultSlippageBps: 75,
    },
    protocols: {
      uniswap: {
        pool: {
          pair: "WETH/USDC",
          fee: 3000,
          priceUsdcPerWeth: 2800,
          tick: 0,
          tickSpacing: 60,
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: 3100,
        sellPriceUsdcPerWeth: 3090,
        buyPriceUsdcPerWeth: 3110,
        effectiveHalfSpreadBps: 32,
      },
      curve: { priceUsdcPerWeth: 2990 },
    },
  };
}
