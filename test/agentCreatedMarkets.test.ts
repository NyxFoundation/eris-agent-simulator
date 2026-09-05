// Agent-created markets (issue #40): the parts that can be decided without a chain.
//
// Everything here is a rule that, if it silently changed, would move the score without moving any
// number anybody looks at — which is why each one is pinned rather than left to the integration run.
import test from "node:test";
import assert from "node:assert/strict";
import { parseAction } from "../sdk/src/action.js";
import { ACTION_TYPES_BY_PROTOCOL } from "../sdk/src/action.js";
import { initProtocols } from "../sdk/src/protocols/registry.js";
import {
  allocateToBalances,
  clampToBalances,
  StrandedLedger,
  type StrandedFlow,
} from "../sdk/src/agentMarkets.js";
import {
  backedFraction,
  lendingAdapter,
  marketIsEmpty,
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
import { withdrawAction, withdrawableNow } from "../example/agents/lib/agentMarkets.js";
import {
  guardProbesFor,
  unprotectedFindings,
} from "../core/src/realtime/ownerGuards.js";
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// What the codex review found, pinned so it cannot come back
// ---------------------------------------------------------------------------

test("a contract that forwarded the tokens on is not holding them", () => {
  // C pulls 100 USDC from A and sends it to B in the same transaction. A's net into C is 100 and C
  // ends with nothing: A did lose the money -- its spot balance says so, and that is where the loss
  // is scored -- but reporting it as "stranded in C" is the wrong account of where it went.
  const flows: StrandedFlow[] = [
    { market: TRAP, token: USDC, amountRaw: 100n },
  ];
  const held = new Map([[`${TRAP.toLowerCase()}|${USDC.toLowerCase()}`, 0n]]);
  assert.deepEqual(clampToBalances(flows, held), []);
});

test("a partial forward is reported at what is left, not at what went in", () => {
  const flows: StrandedFlow[] = [
    { market: TRAP, token: USDC, amountRaw: 100n },
  ];
  const held = new Map([[`${TRAP.toLowerCase()}|${USDC.toLowerCase()}`, 40n]]);
  assert.deepEqual(
    clampToBalances(flows, held).map((f) => f.amountRaw),
    [40n],
  );
});

test("an unread balance reports the net rather than dropping the flow", () => {
  // A balance that could not be read is not evidence that nothing is there.
  const flows: StrandedFlow[] = [
    { market: TRAP, token: USDC, amountRaw: 100n },
  ];
  assert.deepEqual(
    clampToBalances(flows, new Map()).map((f) => f.amountRaw),
    [100n],
  );
});

test("a market with nothing in it holds nobody's position", () => {
  // This is what makes dropping spam markets exact rather than a heuristic: with all three totals
  // at zero, every position in the market is zero by construction.
  const zero = {
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    lastUpdate: 5n,
    totalCollateralAssets: 0n,
  };
  assert.equal(marketIsEmpty(zero), true);
  assert.equal(marketIsEmpty(undefined), true);
  // Collateral alone is enough to make it inhabited: a borrower posted it, and a borrower has a
  // position worth marking even before anybody supplies.
  assert.equal(marketIsEmpty({ ...zero, totalCollateralAssets: 1n }), false);
  assert.equal(marketIsEmpty({ ...zero, totalSupplyAssets: 1n }), false);
  assert.equal(marketIsEmpty({ ...zero, totalBorrowAssets: 1n }), false);
});

test("the gateway reads an EIP-7702 transaction's gas limit", async () => {
  // Type 0x04 shares the 1559 prefix. It used to fall through to "unreadable", and an unreadable
  // gas limit used to mean "let it through" -- which is the whole cap, bypassed by choosing a
  // transaction type the reader did not know about.
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const raw = await account.signTransaction({
    to: "0x0000000000000000000000000000000000000001" as Address,
    gas: 320_000_000n,
    maxFeePerGas: 10n ** 9n,
    maxPriorityFeePerGas: 1n,
    nonce: 1,
    chainId: 31337,
    type: "eip7702",
    authorizationList: [],
  } as never);
  assert.equal(txGasLimit(raw), 320_000_000n);
});

test("an envelope type the reader does not know is unreadable, not zero", () => {
  // Unreadable is the caller's signal to refuse. Returning 0 (or any number) would let an unknown
  // shape past the cap; returning null makes the gateway fail closed.
  assert.equal(txGasLimit("0x7fdeadbeef"), null);
  assert.equal(txGasLimit("0x"), null);
});

// ---------------------------------------------------------------------------
// What the second review pass found
// ---------------------------------------------------------------------------

test("two agents cannot both be told the same tokens are theirs", () => {
  // A and B each put 100 into C; C forwards 100 away and keeps 100. Clamping each agent separately
  // against C's balance reports 100 twice -- 200 sitting in a contract holding 100.
  const held = new Map([[`${TRAP.toLowerCase()}|${USDC.toLowerCase()}`, 100n]]);
  const allocated = allocateToBalances(
    [
      { agent: "a", flows: [{ market: TRAP, token: USDC, amountRaw: 100n }] },
      { agent: "b", flows: [{ market: TRAP, token: USDC, amountRaw: 100n }] },
    ],
    held,
  );
  const total = allocated
    .flatMap((a) => a.flows)
    .reduce((sum, f) => sum + f.amountRaw, 0n);
  assert.equal(total, 100n);
  assert.deepEqual(
    allocated.map((a) => a.flows[0]?.amountRaw),
    [50n, 50n],
  );
});

test("an allocation never inflates a flow above what went in", () => {
  // C holds more than these agents put in (somebody else's money, or its own). Each is still capped
  // by its own net: the balance is an upper bound on the claim, not a source of one.
  const held = new Map([[`${TRAP.toLowerCase()}|${USDC.toLowerCase()}`, 1_000n]]);
  const allocated = allocateToBalances(
    [{ agent: "a", flows: [{ market: TRAP, token: USDC, amountRaw: 100n }] }],
    held,
  );
  assert.equal(allocated[0].flows[0].amountRaw, 100n);
});

test("a withdrawal asks for what the market can pay, not for all of it", () => {
  const lending = {
    singleton: TRAP,
    dropped: 0,
    markets: [
      {
        marketId: `0x${"1".repeat(64)}`,
        loanToken: USDC,
        collateralToken: TRAP,
        oracle: AGENT,
        irm: AGENT,
        lltv: "800000000000000000",
        liquidationIncentiveFactor: "1030927835051546391",
        price: "0",
        supplyAssets: "1000",
        borrowAssets: "0",
        collateral: "0",
        healthy: true,
        totalSupplyAssets: "1000",
        totalBorrowAssets: "600",
      },
    ],
  };
  const id = lending.markets[0].marketId;
  assert.deepEqual(withdrawableNow(lending.markets[0]), {
    supplied: 1000n,
    available: 400n,
  });
  const action = withdrawAction(lending, id, "1");
  assert.equal(action?.amount, "400");
});

test("nothing withdrawable means no transaction at all", () => {
  // Submitting a call that is going to revert costs one of the three transactions the block allows
  // and buys nothing.
  const lending = {
    singleton: TRAP,
    dropped: 0,
    markets: [
      {
        marketId: `0x${"2".repeat(64)}`,
        loanToken: USDC,
        collateralToken: TRAP,
        oracle: AGENT,
        irm: AGENT,
        lltv: "800000000000000000",
        liquidationIncentiveFactor: "0",
        price: "0",
        supplyAssets: "1000",
        borrowAssets: "0",
        collateral: "0",
        healthy: true,
        totalSupplyAssets: "1000",
        totalBorrowAssets: "1000",
      },
    ],
  };
  assert.equal(withdrawAction(lending, lending.markets[0].marketId, "1"), null);
});

test("a fully liquid position still asks for max", () => {
  const lending = {
    singleton: TRAP,
    dropped: 0,
    markets: [
      {
        marketId: `0x${"3".repeat(64)}`,
        loanToken: USDC,
        collateralToken: TRAP,
        oracle: AGENT,
        irm: AGENT,
        lltv: "800000000000000000",
        liquidationIncentiveFactor: "0",
        price: "0",
        supplyAssets: "1000",
        borrowAssets: "0",
        collateral: "0",
        healthy: true,
        totalSupplyAssets: "1000",
        totalBorrowAssets: "0",
      },
    ],
  };
  assert.equal(
    withdrawAction(lending, lending.markets[0].marketId, "1")?.amount,
    "max",
  );
});

test("a guard that could not be established is not a guard", () => {
  // An audit that could not reach the contract has not shown the guard is there, and this whole
  // check exists because reading the source was not good enough evidence.
  const probes = guardProbesFor({ priceFeed: TRAP });
  const findings = probes.map((p) => ({
    label: p.label,
    address: p.address,
    status: "unreachable" as const,
    detail: "no code at the address",
  }));
  assert.equal(unprotectedFindings(findings, probes).length, probes.length);
});

test("the guard audit probes both PriceFeed writes and both oracle overloads", () => {
  const labels = guardProbesFor({
    priceFeed: TRAP,
    gmxOracleProvider: AGENT,
    lstVault: USDC,
  }).map((p) => p.label);
  for (const expected of [
    "PriceFeed.setPrice",
    "PriceFeed.setPriceFor",
    "MockOracleProvider.setPrice(address,uint256)",
    "MockOracleProvider.setPrice(address,uint256,uint256)",
    "MockLSTVault.setWithdrawalDelayBlocks",
    "MockLSTVault.setQueueThroughput",
  ]) {
    assert.ok(labels.includes(expected), `missing probe: ${expected}`);
  }
});

test("a market wiped out by bad debt is not an empty market", () => {
  // Supply 100, borrow 100, collateral goes to zero, liquidate: every asset total is zero and the
  // supplier still holds shares. The position is worth nothing, which is the right mark -- but a
  // market that vanishes from the observation because it was wiped out is one whose holder cannot
  // see what happened to them.
  assert.equal(
    marketIsEmpty({
      totalSupplyAssets: 0n,
      totalSupplyShares: 500n,
      totalBorrowAssets: 0n,
      totalBorrowShares: 0n,
      lastUpdate: 7n,
      totalCollateralAssets: 0n,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Axiom 3 extended to every venue (the deferred T1 item, now decided)
// ---------------------------------------------------------------------------

test("the scored value is the recoverable one, and the mark is reported beside it", async () => {
  // The rule, stated as the shape of the data rather than as prose: a cross-section carries the
  // recoverable value in `valueUsdc` (which is what the epoch series and alpha are built from) and
  // the face mark in `markedValueUsdc`. If those two ever swap places the score silently becomes
  // par again, and nothing else in the system would notice.
  const { readValueSnapshotAtBlock } = await import(
    "../core/src/realtime/reconstruct.js"
  );
  assert.equal(typeof readValueSnapshotAtBlock, "function");
  // The type is the contract. `AgentValueSnapshot` must not carry a field named
  // liquidatableValueUsdc any more: a reader that still asks for it is reading the old rule.
  const source = readFileSync(
    new URL("../core/src/realtime/reconstruct.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /markedValueUsdc: number;/);
  assert.doesNotMatch(source, /liquidatableValueUsdc: number;/);
  // And the scored total must be built from the recoverable value, not the mark.
  assert.match(source, /total \+= value\.liquidatableValueUsdc;/);
  assert.match(source, /alphaTotal \+= value\.liquidatableValueUsdc;/);
});

test("every adapter that can be scored fills the recoverable value", async () => {
  // The flip is only safe because every adapter populates `liquidatableValueUsdc`. One that filled
  // `valueUsdc` and left the other at zero would delete its venue from every agent's score, and the
  // symptom would be a plausible-looking loss rather than an error.
  const files = [
    "uniswap",
    "balancer",
    "curve",
    "gmx",
    "aave",
    "lst",
    "liquity",
    "lending",
  ];
  for (const name of files) {
    const source = readFileSync(
      new URL(`../sdk/src/protocols/${name}.ts`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /liquidatableValueUsdc/,
      `${name} never mentions liquidatableValueUsdc, so it cannot be filling it`,
    );
  }
});

test("the Aave borrower is NOT floored, because nothing takes the other side", () => {
  // The walk-away floor is only sound as one half of a pair: somebody has to eat the shortfall.
  // Liquity's Stability Pool does and SimpleLending socializes it onto suppliers, so both adapters
  // see the loss on the other side. Aave has no such mechanism here and this adapter models none,
  // so flooring the borrower alone would raise the field's total by the shortfall -- the same
  // fabricated value axiom 3 exists to prevent, arrived at from the opposite direction.
  const source = readFileSync(
    new URL("../sdk/src/protocols/aave.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /aave-underwater/);
  assert.doesNotMatch(source, /Math\.max\(0, Number\(net\)/);
  assert.match(source, /Not floored at zero, deliberately/);
});

test("a run with no lending venue has no lending observation at all", async () => {
  // Not present-and-empty. Every caller guards with `if (!lending?.singleton)`, and the zero address
  // passes that guard because it is a non-empty string -- so returning it made "there is no venue"
  // read as "the venue is at 0x0". Measured: a 32-agent bench registered no lending markets for
  // exactly this reason, and the run looked like one where nobody chose to create any.
  const { observeLending } = await import("../sdk/src/protocols/lending.js");
  const observation = await observeLending(
    {} as never,
    {
      singleton: undefined,
      marketIds: [],
      paramsById: {},
      totalsById: {},
      priceById: {},
      oracleOwnerById: {},
      dropped: 0,
    },
    AGENT,
  );
  assert.equal(observation, undefined);
});

test("the container wrapper forwards every env the capability needs", () => {
  // A containerised agent that cannot see the registry or the venue fails *quietly*: it reads an
  // empty registry and an absent venue, which is what a run where nobody deployed anything looks
  // like. The omission cost a whole load test before it was noticed.
  const wrapper = readFileSync(
    new URL("../infra/docker-agent/run-agent.sh", import.meta.url),
    "utf8",
  );
  // Every name the coordinator sets for a child (agentProcess.ts + agentExtraEnv), except the ones
  // run-agent.sh remaps itself (ERIS_RUN_DIR / ERIS_AGENT_DIR / ERIS_CONFIG).
  for (const name of [
    "ERIS_MARKET_REGISTRY_ADDRESS",
    "ERIS_LENDING_ADDRESS",
    "ERIS_MARKET_REGISTRY_FROM_BLOCK",
    "ERIS_MAX_TX_GAS",
    "ERIS_MAX_AGENT_BLOCK_GAS",
    "ERIS_VULN_FACTORY",
    "ERIS_LIQUIDATION_VICTIMS",
    "NODE_ENV",
    "REPORT_DIR",
  ]) {
    assert.ok(
      wrapper.includes(`-e ${name}`),
      `run-agent.sh does not forward ${name}`,
    );
  }
});

test("a venue that is not there is absent from protocols, not undefined in it", async () => {
  // `Object.keys(obs.protocols)` is what the revision prompt reads to tell a model which venues it
  // may trade (ADR 0018), and a key whose value is undefined still appears there. The model would
  // be told it can trade a venue that does not exist, write a strategy around it, and have every
  // action rejected at build time.
  const source = readFileSync(
    new URL("../sdk/src/observation.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(obs !== undefined\)/);
});
