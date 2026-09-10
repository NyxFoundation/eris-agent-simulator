import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { defineChain } from "viem";
import "dotenv/config";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const RPC_PORT = Number(new URL(RPC_URL).port || "8545");

// anvil's public test mnemonic. Index 0 = deployer / owner.
//
// It is the default because every local flow (README, CI, the poc's own local-deploy guide) expects
// these addresses. It must not be the mnemonic of a chain that accepts transactions from anyone:
// the words are printed in anvil's banner, so "the deployer" is then a key every participant
// already holds -- and the deployer is Aave's POOL_ADMIN, GMX's CONFIG_KEEPER, the owner of every
// seeded LP position and the holder of the genesis Trove's eUSD. Pass a secret one through
// MNEMONIC (issue #74); `deployer/.env` is gitignored, so it never reaches the repository.
export const DEFAULT_MNEMONIC =
  "test test test test test test test test test test test junk";

/**
 * Normalize + validate a mnemonic.
 *
 * Whitespace-normalized because a mnemonic pasted out of a password manager or read from a file
 * tends to arrive with a trailing newline or doubled spaces, which would fail the check below over
 * words that are, to the operator, plainly correct.
 *
 * Validated because derivation does not validate: viem's `mnemonicToAccount` seeds happily from any
 * string, so a mnemonic with one word wrong produces a perfectly usable set of keys -- just not the
 * set the operator wrote down. That is discovered on the day the chain has to be redeployed from
 * the stored words, which is the worst possible day to discover it.
 */
export function normalizeMnemonic(raw: string): string {
  const mnemonic = raw.trim().replace(/\s+/g, " ");
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error(
      "MNEMONIC is not a valid BIP-39 mnemonic (checked before anything is deployed). It has to " +
        "be 12/15/18/21/24 words from the English wordlist, and one wrong word fails the " +
        "checksum. Unset it to fall back to anvil's public test mnemonic.",
    );
  }
  return mnemonic;
}

export const MNEMONIC = normalizeMnemonic(
  process.env.MNEMONIC ?? DEFAULT_MNEMONIC,
);

// A deploy onto a chain that anyone can reach should say so once, loudly, rather than leave it to
// be discovered from anvil's banner.
export const MNEMONIC_IS_DEFAULT = MNEMONIC === DEFAULT_MNEMONIC;

// Whether the deployer manages the anvil process lifecycle (start through stop) itself.
export const MANAGE_ANVIL =
  (process.env.MANAGE_ANVIL ?? "true").toLowerCase() === "true";

// Default chainId of an empty anvil. Overridable because the same deploy path targets the external
// chain of issue #35, whose id comes from its genesis (issue #33 (4)).
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");

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
