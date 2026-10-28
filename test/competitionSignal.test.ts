// What obs.competition counts as a competitor's bid (example/agents/runtime/send.ts blockBids).
//
// The environment's GMX keeper executes orders at a fixed 50 gwei so a full block cannot shut it out
// (ADR 0011). Counted as a competitor it set the signal in ~57% of blocks, and strategies that bid
// "competitor + margin" up to a share of their edge sat at that ceiling after every such block. The
// environment's privileged calls are left out by destination; nothing a participant can deploy or
// name is.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { GMX, LST } from "../sdk/src/constants.js";
import {
  blockBids,
  environmentCallFilter,
  type BlockTxBid,
} from "../example/agents/runtime/send.js";

const GWEI = 1_000_000_000n;
const SELF = "0x00000000000000000000000000000000000a11ce" as Address;
const RIVAL = "0x0000000000000000000000000000000000000b0b" as Address;
const KEEPER = "0x00000000000000000000000000000000000ee9e9" as Address;
const PRICE_FEED = "0x00000000000000000000000000000000000fee0d" as Address;
const VAULT = "0x0000000000000000000000000000000000001575" as Address;
const SOMEWHERE = "0x0000000000000000000000000000000000c0ffee" as Address;

const abi = parseAbi([
  "function slash(uint256 bps) returns (uint256)",
  "function setRewardRate(uint256 ratePerBlockRay)",
  "function setAnswer(int256 answer)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
]);
const SLASH = encodeFunctionData({ abi, functionName: "slash", args: [1n] });
const SET_REWARD_RATE = encodeFunctionData({ abi, functionName: "setRewardRate", args: [1n] });
const SET_ANSWER = encodeFunctionData({ abi, functionName: "setAnswer", args: [1n] });
const DEPOSIT = encodeFunctionData({ abi, functionName: "deposit", args: [1n, SELF] });

const filter = environmentCallFilter({
  contracts: [GMX.OrderHandler, GMX.LiquidationHandler, PRICE_FEED, undefined],
  lstVault: VAULT,
});
const tx = (
  from: Address,
  gwei: bigint | undefined,
  to: Address | null,
  input: Hex = "0x",
): BlockTxBid => ({
  from,
  to,
  input,
  ...(gwei === undefined ? {} : { maxPriorityFeePerGas: gwei * GWEI }),
});

test("the GMX keeper's executions and liquidations are not a competitor's bid", () => {
  const block = [
    tx(KEEPER, 50n, GMX.OrderHandler),
    tx(KEEPER, 50n, GMX.LiquidationHandler.toUpperCase().replace("0X", "0x") as Address),
    tx(RIVAL, 2n, SOMEWHERE),
    tx(SELF, 3n, SOMEWHERE),
  ];
  assert.deepEqual(blockBids(block, SELF, filter), { competitor: 2n * GWEI, block: 3n * GWEI });
  // Before: the keeper was the answer whenever it was in the block.
  assert.deepEqual(blockBids(block, SELF, () => false), { competitor: 50n * GWEI, block: 50n * GWEI });
});

test("a block with only the environment's calls reads as no competition", () => {
  const block = [tx(KEEPER, 50n, GMX.OrderHandler), tx(KEEPER, 6n, PRICE_FEED)];
  assert.deepEqual(blockBids(block, SELF, filter), { competitor: 0n, block: 0n });
});

test("the LST vault's operator calls are left out, its deposits are not", () => {
  const block = [
    tx(KEEPER, 100n, VAULT, SLASH),
    tx(KEEPER, 9n, VAULT, SET_REWARD_RATE),
    tx(RIVAL, 4n, VAULT, DEPOSIT),
  ];
  assert.equal(blockBids(block, SELF, filter).competitor, 4n * GWEI);
});

test("an operator selector sent anywhere else is still a bid", () => {
  // A participant's own contract can name its trade function after an environment setter. Left
  // out by selector, its real bids would vanish from every competitor's signal.
  const block = [
    tx(RIVAL, 40n, SOMEWHERE, SET_ANSWER),
    tx(RIVAL, 30n, SOMEWHERE, SLASH),
  ];
  assert.equal(blockBids(block, SELF, filter).competitor, 40n * GWEI);
});

test("contract creations and legacy transactions are counted as before", () => {
  const block = [tx(RIVAL, 7n, null), tx(RIVAL, undefined, SOMEWHERE)];
  assert.equal(blockBids(block, SELF, filter).competitor, 7n * GWEI);
});

test("the filter takes the deployment's own LST vault when there is one", () => {
  if (!LST) return;
  const own = environmentCallFilter({ contracts: [], lstVault: LST.vault });
  assert.equal(own(tx(KEEPER, 100n, LST.vault, SLASH)), true);
  assert.equal(own(tx(RIVAL, 1n, LST.vault, DEPOSIT)), false);
});
