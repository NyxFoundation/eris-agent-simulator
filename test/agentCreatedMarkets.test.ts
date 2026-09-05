// Agent-created markets (issue #40): the parts that can be decided without a chain.
//
// Everything here is a rule that, if it silently changed, would move the score without moving any
// number anybody looks at — which is why each one is pinned rather than left to the integration run.
import test from "node:test";
import assert from "node:assert/strict";
import { parseAction } from "../sdk/src/action.js";
import { ACTION_TYPES_BY_PROTOCOL } from "../sdk/src/action.js";
import { initProtocols } from "../sdk/src/protocols/registry.js";
import { StrandedLedger } from "../sdk/src/agentMarkets.js";
import {
  backedFraction,
  lendingAdapter,
} from "../sdk/src/protocols/lending.js";
import {
  registryKindIndex,
  registryKindOf,
  REGISTRY_KINDS,
} from "../sdk/src/marketRegistry.js";
import { checkGasViolations } from "../core/src/postRunCheck.js";
import { BLOCKS_CSV_COLUMNS } from "../core/src/logger.js";
import { venueExecQuotes } from "../core/src/realtime/noArb.js";
import { txGasLimit } from "../infra/rpc-gateway/txGas.mjs";
import { sqrtPriceX96For } from "../sdk/src/protocols/uniswap.js";
import type { Address } from "viem";

// ---------------------------------------------------------------------------
// The round-trip rule's one new number
// ---------------------------------------------------------------------------

const AGENT = "0x00000000000000000000000000000000000000aa" as Address;
const TRAP = "0x00000000000000000000000000000000000000bb" as Address;
const USDC = "0x00000000000000000000000000000000000000cc" as Address;

function transfer(from: string, to: string, value: bigint, token = USDC) {
  return {
    address: token as Address,
    // Three topics = a fungible Transfer. ERC-721 shares topic0 and adds a fourth.
    topics: ["0x0", "0x0", "0x0"] as const,
    args: { from: from as Address, to: to as Address, value },
  };
}

test("stranded ledger reports what went in and did not come back", () => {
  const ledger = new StrandedLedger();
  const markets = new Set([TRAP.toLowerCase()]);
  ledger.apply(
    [
      transfer(AGENT, TRAP, 10_000n),
      transfer(TRAP, AGENT, 4_000n),
    ],
    AGENT,
    markets,
  );
  assert.deepEqual(
    ledger.outstanding().map((f) => f.amountRaw),
    [6_000n],
  );
});

test("profit taken through an unknown contract is not a debt", () => {
  // Deposit 10,000, withdraw 11,000. The +1,000 is already in the wallet and counted by ordinary
  // spot accounting; nothing is stranded, and a negative net must never be reported as one.
  const ledger = new StrandedLedger();
  ledger.apply(
    [transfer(AGENT, TRAP, 10_000n), transfer(TRAP, AGENT, 11_000n)],
    AGENT,
    new Set([TRAP.toLowerCase()]),
  );
  assert.equal(ledger.outstanding().length, 0);
});

test("transfers to contracts outside the tracked set are ignored", () => {
  const ledger = new StrandedLedger();
  ledger.apply(
    [transfer(AGENT, "0x00000000000000000000000000000000000000dd", 5n)],
    AGENT,
    new Set([TRAP.toLowerCase()]),
  );
  assert.equal(ledger.outstanding().length, 0);
});

test("a four-topic Transfer (ERC-721) is not a quantity of anything", () => {
  const ledger = new StrandedLedger();
  ledger.apply(
    [
      {
        address: USDC,
        topics: ["0x0", "0x0", "0x0", "0x0"] as const,
        args: { from: AGENT, to: TRAP, value: 1n },
      },
    ],
    AGENT,
    new Set([TRAP.toLowerCase()]),
  );
  assert.equal(ledger.outstanding().length, 0);
});

// ---------------------------------------------------------------------------
// Axiom 3: a supply position marks at recoverable value, not par
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;

test("an untouched market is fully backed", () => {
  const fraction = backedFraction(
    {
      totalSupplyAssets: 10_000n,
      totalSupplyShares: 0n,
      totalBorrowAssets: 0n,
      totalBorrowShares: 0n,
      lastUpdate: 0n,
      totalCollateralAssets: 0n,
    },
    0n,
  );
  assert.equal(fraction, WAD);
});

test("the oracle-drain attack marks the supplier at zero", () => {
  // The worked example from the issue: V supplies 10,000 USDC, T posts worthless collateral, marks
  // it high through its own oracle, borrows the 10,000 and withdraws to an EOA. At par V still
  // reads 10,000 and the field's total rises by 10,000 -- fabricated value. At recoverable it is a
  // transfer, which is what makes the books balance.
  const fraction = backedFraction(
    {
      totalSupplyAssets: 10_000n,
      totalSupplyShares: 0n,
      totalBorrowAssets: 10_000n,
      totalBorrowShares: 0n,
      lastUpdate: 0n,
      totalCollateralAssets: 1_000_000n,
    },
    // The environment does not price the collateral token, so it is worth nothing here whatever the
    // market's own oracle says.
    0n,
  );
  assert.equal(fraction, 0n);
});

test("debt backed by collateral the environment does price is recoverable", () => {
  const fraction = backedFraction(
    {
      totalSupplyAssets: 10_000n,
      totalSupplyShares: 0n,
      totalBorrowAssets: 10_000n,
      totalBorrowShares: 0n,
      lastUpdate: 0n,
      totalCollateralAssets: 0n,
    },
    12_000n, // real collateral worth more than the debt
  );
  assert.equal(fraction, WAD);
});

test("half-backed debt marks the supplier at half", () => {
  const fraction = backedFraction(
    {
      totalSupplyAssets: 10_000n,
      totalSupplyShares: 0n,
      totalBorrowAssets: 10_000n,
      totalBorrowShares: 0n,
      lastUpdate: 0n,
      totalCollateralAssets: 0n,
    },
    5_000n,
  );
  assert.equal(fraction, WAD / 2n);
});

// ---------------------------------------------------------------------------
// The action surface
// ---------------------------------------------------------------------------

test("the lending vocabulary is owned by the lending adapter", () => {
  initProtocols(["uniswap", "lending"]);
  for (const type of ACTION_TYPES_BY_PROTOCOL.lending) {
    assert.ok(
      lendingAdapter.parse({
        type,
        marketId: `0x${"1".repeat(64)}`,
        amount: "1",
        borrower: AGENT,
        seizedAssets: "1",
        loanToken: USDC,
        collateralToken: TRAP,
        oracle: AGENT,
        irm: "0x0000000000000000000000000000000000000000",
        lltv: "900000000000000000",
      }),
      `${type} is not owned by the lending adapter`,
    );
  }
});

test("an LLTV at or above 100% is refused", () => {
  assert.throws(() =>
    lendingAdapter.parse({
      type: "createLendingMarket",
      loanToken: USDC,
      collateralToken: TRAP,
      oracle: AGENT,
      irm: "0x0000000000000000000000000000000000000000",
      lltv: "1000000000000000000",
    }),
  );
});

test("a rawTx with no `to` is a deployment", () => {
  const action = parseAction({ type: "rawTx", tx: { data: "0x6080" } });
  assert.equal(action.type, "rawTx");
  assert.equal((action as { tx: { to?: string } }).tx.to, undefined);
});

test("a deployment with no bytecode is refused", () => {
  assert.throws(() => parseAction({ type: "rawTx", tx: { data: "0x" } }));
});

test("createPool refuses a fee tier the factory does not enable", () => {
  initProtocols(["uniswap"]);
  assert.throws(() =>
    parseAction({
      type: "createPool",
      tokenA: USDC,
      tokenB: TRAP,
      fee: 1234,
      sqrtPriceX96: "1",
    }),
  );
});

test("createPool refuses a pair with itself", () => {
  initProtocols(["uniswap"]);
  assert.throws(() =>
    parseAction({
      type: "createPool",
      tokenA: USDC,
      tokenB: USDC,
      fee: 3000,
      sqrtPriceX96: "1",
    }),
  );
});

test("sqrtPriceX96For round-trips a 3000 USDC/WETH pool", () => {
  // token0 = WETH (18), token1 = USDC (6) at the local deployment's sort order.
  const sqrtPriceX96 = sqrtPriceX96For({
    humanPrice: 3000,
    token0Decimals: 18,
    token1Decimals: 6,
  });
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const price = ratio * ratio * 10 ** 12;
  assert.ok(Math.abs(price - 3000) / 3000 < 1e-6, `got ${price}`);
});

// ---------------------------------------------------------------------------
// The gas budget (T0)
// ---------------------------------------------------------------------------

function csv(rows: Array<Record<string, string>>): string {
  const header = BLOCKS_CSV_COLUMNS.join(",");
  const lines = rows.map((r) =>
    BLOCKS_CSV_COLUMNS.map((c) => r[c] ?? "").join(","),
  );
  return [header, ...lines].join("\n");
}

test("a single over-cap transaction is a violation", () => {
  const violations = checkGasViolations(
    csv([
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x1", gasUsed: "40000000" },
    ]),
    { maxTxGas: 30_000_000n, maxAgentBlockGas: 90_000_000n },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "per-tx");
});

test("three legal transactions that together starve the block are a violation", () => {
  const violations = checkGasViolations(
    csv([
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x1", gasUsed: "29000000" },
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x2", gasUsed: "29000000" },
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x3", gasUsed: "29000000" },
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x4", gasUsed: "29000000" },
    ]),
    { maxTxGas: 30_000_000n, maxAgentBlockGas: 90_000_000n },
  );
  assert.equal(violations.filter((v) => v.kind === "per-tx").length, 0);
  assert.equal(violations.filter((v) => v.kind === "per-block").length, 1);
});

test("gas is summed per agent per block, not across agents or blocks", () => {
  const violations = checkGasViolations(
    csv([
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x1", gasUsed: "60000000" },
      { role: "agent", ownerId: "b", blockNumber: "10", hash: "0x2", gasUsed: "60000000" },
      { role: "agent", ownerId: "a", blockNumber: "11", hash: "0x3", gasUsed: "60000000" },
    ]),
    { maxTxGas: 30_000_000n, maxAgentBlockGas: 90_000_000n },
  );
  assert.equal(violations.filter((v) => v.kind === "per-block").length, 0);
});

test("a run recorded before the column existed is not reported as clean", () => {
  // Empty gasUsed means "never measured". Reading it as zero would give a run from before the
  // column a clean bill of health it never earned.
  const violations = checkGasViolations(
    csv([{ role: "agent", ownerId: "a", blockNumber: "10", hash: "0x1" }]),
    { maxTxGas: 1n, maxAgentBlockGas: 1n },
  );
  assert.equal(violations.length, 0);
});

test("the environment's own transactions are not gas-checked", () => {
  const violations = checkGasViolations(
    csv([
      { role: "system", ownerId: "oracle", blockNumber: "10", hash: "0x1", gasUsed: "999999999" },
    ]),
    { maxTxGas: 30_000_000n, maxAgentBlockGas: 90_000_000n },
  );
  assert.equal(violations.length, 0);
});

test("a zero ceiling disables its check", () => {
  const violations = checkGasViolations(
    csv([
      { role: "agent", ownerId: "a", blockNumber: "10", hash: "0x1", gasUsed: "999999999" },
    ]),
    { maxTxGas: 0n, maxAgentBlockGas: 0n },
  );
  assert.equal(violations.length, 0);
});

// ---------------------------------------------------------------------------
// The gateway reads the gas limit without executing anything
// ---------------------------------------------------------------------------

test("the gateway reads a 1559 transaction's gas limit", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  for (const tx of [
    {
      to: "0x0000000000000000000000000000000000000001" as Address,
      gas: 123_456n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 1n,
      nonce: 3,
      chainId: 31337,
      type: "eip1559" as const,
    },
    {
      to: "0x0000000000000000000000000000000000000001" as Address,
      gas: 40_000_000n,
      gasPrice: 10n ** 9n,
      nonce: 3,
      chainId: 31337,
      type: "legacy" as const,
    },
  ]) {
    const raw = await account.signTransaction(tx as never);
    assert.equal(txGasLimit(raw), tx.gas);
  }
});

test("a deployment's gas limit is readable too (there is no `to` to key on)", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const raw = await account.signTransaction({
    data: "0x6080604052",
    gas: 5_000_000n,
    maxFeePerGas: 10n ** 9n,
    maxPriorityFeePerGas: 1n,
    nonce: 0,
    chainId: 31337,
    type: "eip1559",
  } as never);
  assert.equal(txGasLimit(raw), 5_000_000n);
});

// ---------------------------------------------------------------------------
// Boundaries the capability must not cross
// ---------------------------------------------------------------------------

test("the no-arb guard never sees an agent-created market", () => {
  // The guard reads the enabled adapters' states, and those come from MARKET_LEGS -- the venues the
  // environment deployed. A thin agent-made pool is *supposed* to sit away from fair, so it must
  // not be able to fail the run at startup or raise a persistent-spread warning.
  const quotes = venueExecQuotes(
    new Map([
      [
        "uniswap",
        {
          markets: [
            {
              market: { base: "WETH", uniswap: { fee: 3000 } },
              priceUsdcPerWeth: 3000,
            },
          ],
        },
      ],
      // `lending` is not one of the three AMM venues the guard reads, and there is no way to add an
      // agent-created pool to this map: the states are built from the adapter registry.
      ["lending", { markets: [] }],
    ]),
    ["uniswap", "lending"],
  );
  assert.deepEqual(Object.keys(quotes), ["WETH"]);
  assert.equal(quotes.WETH.length, 1);
});

test("the registry kind enum matches the contract's ordering", () => {
  // The index is the on-chain enum's. A reordering here without one there silently re-labels every
  // entry -- an `unknown` contract would start reading as a verified pool.
  assert.equal(REGISTRY_KINDS[0], "unknown");
  assert.equal(REGISTRY_KINDS[1], "uniswapV3Pool");
  assert.equal(REGISTRY_KINDS[5], "lendingMarket");
  assert.equal(REGISTRY_KINDS[6], "erc20");
  for (let i = 0; i < REGISTRY_KINDS.length; i++)
    assert.equal(registryKindIndex(registryKindOf(i)), i);
});

test("an out-of-range kind reads as unknown, never as verified", () => {
  assert.equal(registryKindOf(99), "unknown");
});
