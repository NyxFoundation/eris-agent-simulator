import { defineChain } from "viem";
import "dotenv/config";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const RPC_PORT = Number(new URL(RPC_URL).port || "8545");

// anvil default mnemonic. index 0 = deployer / owner.
export const MNEMONIC =
  process.env.MNEMONIC ??
  "test test test test test test test test test test test junk";

// Whether the deployer manages the anvil process lifecycle (start through stop) itself.
export const MANAGE_ANVIL =
  (process.env.MANAGE_ANVIL ?? "true").toLowerCase() === "true";

// Default chainId of an empty anvil.
export const CHAIN_ID = 31337;

export const anvilChain = defineChain({
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// Account role assignments (index into the mnemonic)
export const ACCOUNT_INDEX = {
  deployer: 0,
  keeper: 1,
  trader: 2,
} as const;

// Shared mock token specs. Shared by Uniswap / Balancer / Curve / GMX.
// (Aave is managed separately since deploy-v3 generates its own test tokens)
export type TokenSpec = {
  key: string;
  name: string;
  symbol: string;
  decimals: number;
};

export const TOKEN_SPECS: TokenSpec[] = [
  { key: "WETH", name: "Wrapped Ether", symbol: "WETH", decimals: 18 }, // special-cased (WETH9)
  { key: "USDC", name: "USD Coin", symbol: "USDC", decimals: 6 },
  { key: "USDT", name: "Tether USD", symbol: "USDT", decimals: 6 },
  { key: "DAI", name: "Dai Stablecoin", symbol: "DAI", decimals: 18 },
  { key: "WBTC", name: "Wrapped BTC", symbol: "WBTC", decimals: 8 },
];

// Amount of each token to initially mint to the deployer (human-readable)
export const INITIAL_MINT: Record<string, string> = {
  USDC: "100000000", // 100M USDC
  USDT: "100000000",
  DAI: "100000000",
  WBTC: "10000", // 10k WBTC
};
