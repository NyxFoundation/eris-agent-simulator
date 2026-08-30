// What a transaction did, from its calldata (ADR 0021 §4).
//
// The explorer used to get this by joining against the agents' own logs: each agent self-reports the
// action type of every tx it submits, and the run's blocks were matched to those lines by hash. That
// works exactly as long as the coordinator is the thing starting the agents. On the practice devnet
// they are other people's processes on other people's machines, and none of those lines reach the
// operator -- so every external participant's transactions would read as "direct", which is not a
// method, and the panel would be least informative precisely where most of the traffic is.
//
// The chain has the answer. A tx's first four bytes are the function selector, and the environment
// deployed every contract on this chain, so the sdk already holds the ABI of everything worth
// naming. This is the same discipline the rest of the scoring path follows -- the source of truth is
// the chain, never a participant's account of what they did.
//
// A selector this table does not know resolves to nothing rather than to a guess: an unnamed method
// is honest, and a wrong name is worse than a hex string.
import { toFunctionSelector, type Abi, type AbiFunction, type Hex } from "viem";
import {
  balancerVaultAbi,
  borrowerOperationsAbi,
  curveStableSwapNgAbi,
  curveTricryptoAbi,
  curveTwocryptoLiquidityAbi,
  erc20Abi,
  liquityRedemptionHelperAbi,
  lstVaultAbi,
  nonfungiblePositionManagerAbi,
  stabilityPoolAbi,
  swapRouterAbi,
  troveManagerAbi,
  wethAbi,
} from "./abis.js";
import { aavePoolAbi, mockAggregatorAbi } from "./protocols/aave.js";
import { priceFeedAbi } from "./priceFeed.js";

// GMX's ExchangeRouter is the one venue whose ABI lives inside its adapter as a private const,
// because nothing else needed it. The three entry points an agent or the keeper actually calls are
// restated here rather than exporting the whole thing, which would make the adapter's internals part
// of the sdk's surface for the sake of three names.
const gmxRouterAbi = [
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [{ name: "params", type: "bytes" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "sendWnt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sendTokens",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

// Aave's liquidation entry point. Not in aavePoolAbi, which holds only what the adapter calls: a
// liquidation is built by the liquidator strategy as a raw tx (example/agents/lib/aave-liquidation.ts).
// The explorer colours this one differently from every other method, so a run where liquidations
// fired and none of them were named would be missing the panel's whole point.
const aaveLiquidationAbi = [
  {
    type: "function",
    name: "liquidationCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "receiveAToken", type: "bool" },
    ],
    outputs: [],
  },
] as const;

// Multicall3's aggregate3, which every batched read goes through -- named so a block full of them
// does not read as a block full of unknowns.
const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [{ name: "calls", type: "bytes" }],
    outputs: [{ name: "returnData", type: "bytes" }],
  },
] as const;

const ABIS: readonly Abi[] = [
  erc20Abi,
  wethAbi,
  swapRouterAbi,
  nonfungiblePositionManagerAbi,
  balancerVaultAbi,
  curveTwocryptoLiquidityAbi,
  curveStableSwapNgAbi,
  curveTricryptoAbi,
  aavePoolAbi,
  aaveLiquidationAbi as unknown as Abi,
  mockAggregatorAbi,
  priceFeedAbi as unknown as Abi,
  lstVaultAbi,
  borrowerOperationsAbi,
  troveManagerAbi,
  stabilityPoolAbi,
  liquityRedemptionHelperAbi,
  gmxRouterAbi as unknown as Abi,
  multicall3Abi as unknown as Abi,
];

function buildSelectorTable(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const abi of ABIS) {
    for (const item of abi) {
      if (item.type !== "function") continue;
      let selector: Hex;
      try {
        selector = toFunctionSelector(item as AbiFunction);
      } catch {
        continue;
      }
      // First definition wins. Two ABIs can legitimately share a selector -- `transfer(address,
      // uint256)` appears in every token -- and the first is as good a name as the second.
      if (!(selector in table)) table[selector] = item.name;
    }
  }
  return table;
}

/**
 * The selector table, derived from the ABIs above.
 *
 * Nothing at runtime calls this. It is the *definition* of the table, and the generator
 * (scripts/genMethodSelectors.ts) writes its output into methodSelectors.ts, which is what everyone
 * imports -- because that module has no dependencies, and this one pulls in viem's ABI parser and a
 * keccak implementation. The dashboard decodes calldata in the browser, and shipping an ABI parser
 * to name 123 functions cost 15kB gzipped and a hash computation on every page load.
 *
 * The two are kept honest by a test that recomputes this and compares (test/methodNames.test.ts),
 * so a venue whose ABI changes fails the build rather than quietly losing its name.
 */
export function buildMethodSelectors(): Record<string, string> {
  return buildSelectorTable();
}
