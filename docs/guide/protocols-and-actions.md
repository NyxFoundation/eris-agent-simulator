[← README](../../README.md)

# Protocols and Actions

Each adapter (`sdk/src/protocols/<name>.ts`) implements parse/validate, calldata construction (buildTxs), observation (readState / observe), PnL valuation (valueUsdc), and a setup hook (orderflow generation is the environment's job in `core/src/flow/`). Active protocols are chosen per run via the config's `run.protocols` (YAML array) or the CLI flag `--protocols uniswap,balancer,curve,aave,gmx,lst,liquity`. `sdk/src/action.ts`'s `ACTION_TYPES_BY_PROTOCOL` is the single source for which actions a given run offers — it is also what the strategy-revision prompt enumerates, so a strategy is never left unaware of an action it has simply never used. Agent JSON actions:

| Protocol | Actions | Markets (local deploy = the competition) |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees`, `createPool` | WETH/USDC and WBTC/USDC, 0.3% fee, full-range liquidity (about 1,000 WETH / 50 WBTC + 3M USDC each at the start) |
| Balancer v2 | `balancerSwap` | 50/50 weighted WETH/USDC and WBTC/USDC, 0.3% fee, same starting depth |
| Curve | `curveSwap`, `stableSwap` | twocrypto-ng WETH/USDC and WBTC/USDC (dynamic fee 0.26–0.45%, same starting depth), plus the stableswap-ng pools that quote each market-priced stable (USDC/DAI 100k/100k) |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | WETH / USDC / WBTC reserves; the LST as a collateral-only reserve (LTV 70% / LT 75%), named `asset: "LST"` (not `"ERLST"`) |
| GMX v2 | `gmxIncrease`, `gmxDecrease`, `gmxCancelOrder` | ETH/USD perp (default; WETH or USDC collateral) and BTC/USD perp (`base: "WBTC"`; WBTC or USDC collateral). WETH collateral is sent from the native ETH balance |
| LST | `lstDeposit`, `lstSwap`, `lstRequestWithdraw`, `lstClaimWithdraw` | a wstETH-style vault (ERLST) plus its LST/WETH stableswap-ng market |
| Liquity (eUSD) | `liquityOpenTrove`, `liquityAdjustTrove`, `liquityCloseTrove`, `liquityRedeem`, `liquityProvideToSP`, `liquityWithdrawFromSP`, `liquityLiquidate`, `liquitySwapEusd` | a Liquity V1 fork issuing eUSD, plus its eUSD/USDC stableswap-ng market (100k/100k) |
| Permissionless lending (`lending`; deployed only when the run's protocols include it, which no official regime does) | `createLendingMarket`, `lendingSupply`, `lendingWithdraw`, `lendingSupplyCollateral`, `lendingWithdrawCollateral`, `lendingBorrow`, `lendingRepay`, `lendingLiquidate` | the `SimpleLending` singleton (issue #40). Not in the official regimes; only the verification regime `config/regimes/agent-markets.yaml` enables it |

Only Uniswap has dedicated LP actions. On the Balancer and Curve WETH/USDC and WBTC/USDC pools you can
still provide liquidity by calling the pool directly through `rawTx`, and the BPT / Curve LP token you
receive is valued in scoring (issue #41). LP tokens of the stableswap pools are not valued.

The competition and every official regime run on the local deploy (`run.localDeploy: true`), with
all seven protocols enabled except that `depeg` and `depeg-persist` leave out GMX. The Arbitrum fork
mode (`localDeploy: false`) is a development path with different pools (Uniswap WETH/USDC 0.05%,
Balancer 33/33/34 WETH/USDC/USDT, Curve tricrypto WETH↔USDT), and it cannot run `lst` or `liquity`,
which have no Arbitrum counterpart. For what each protocol is and how it works, written for readers
new to DeFi, see the "seven protocols" section of the
[participant guide](../competition-start.en.md#the-seven-protocols).

`stableSwap` (issue #27) trades a **market-priced stable** against USDC on the pool that quotes it:
`{"type":"stableSwap","stable":"DAI","tokenIn":"USDC","amountIn":"…"}`. It lives on the Curve
adapter because those pools come off the Curve factory, so a run has to enable `curve` to reach any
of them — and a stable whose owning venue is disabled is not tradable, not swept and not priced,
which is the only combination that leaves nothing to fall through the cracks. There is no order-size
cap. Size each leg against the token's actual balance and decimals (USDC has six; DAI/eUSD have
eighteen), then account for pool depth, fees and slippage.

The LST venue (issue #38) has no fork counterpart (Liquity has none either) — the vault is deployed
by `deployer/`, so a fork run that lists `lst` fails fast at startup. It is also the one venue where an
asset has two prices at once: `protocols.lst` reports the vault's `redemptionRateWeth` (reachable
only through a withdrawal queue that takes `withdrawalDelayBlocks`) and the pool's
`marketPriceWeth` (instant, at whatever discount it trades) separately.

**Scoring marks the position at what an exit would realize**, not at par (issue #40 axiom 3 /
ADR 0022 Amendment 1). Realizable is the better of selling into the pool at your own size and a
queued redemption that *finalizes before the run ends*. Face value — what the vault owes, which is
also the number Aave's oracle uses — is reported as `markedValueUsdc` in `summary.json` for the
agents where the two differ, so the gap is legible rather than silent. Pending WETH that finalizes
after the run is excluded and reported under `scoring_unpriced_holdings` with
`reason: "unrealizable"`. `obs.blocksRemaining` is what lets a strategy tell which exits can still
complete — and under this rule that is a scoring question, not a preference.

Actions default to the WETH market. Add `base: "WBTC"` to the swap, Uniswap LP and GMX actions to trade the WBTC/USDC spot pools and the GMX BTC/USD market instead (multi-asset; ADR 0013; the legs are listed in `MARKET_LEGS`). Aave actions take no `base`: the reserve is chosen by `asset` (`"WBTC"`).

In addition there are the protocol-agnostic `noop` / `bundle` (multiple bundleable leaves in a single tx) / `rawTx` / `rawBundle`.

> Actions are expressed as JSON. `bundle` groups bundleable leaves into a single tx (GMX is async, so it can only be sent alone). `rawTx` / `rawBundle` also let you send raw calldata. There are no per-order amount caps. Semantic actions validate inventory and action fields; raw calldata is not decoded for semantic inventory checks. Both paths enforce priority-fee and gas bounds, including the per-agent block gas budget. Post-run checks record violations in `summary.json`.

## Stablecoin Accounting

In the local deploy every venue quotes USDC, and USDC is the numéraire: `$1` by definition, 6
decimals (`setActiveStables` / `getBalances` in `sdk/src/chain.ts`). The Arbitrum fork mode also
treats USDC.e and USDT as **USDC-equivalent** at `$1`, because Arbitrum's deep WETH/stable liquidity
lives in those pools (there Curve uses USDT, and Balancer's pool is seeded at fork time).

Two things changed in issue #27, and both are visible to agents:

- **`balances.usdcUnits` is native USDC alone.** It used to be every active stable summed, which is
  not a number anyone can spend — USDT is not accepted in a USDC pool. Treat it as a budget for a
  USDC leg; what the wallet is *worth* is `inventory.valueUsdc`.
- **A stable with a market is worth what that market pays**, not `$1`. `balances.stables` carries
  each one's balance, decimals and `priceUsdc` (the two-sided executable mid of its own pool), and
  the scorer marks spot balances and LP legs at the same number. `marketQuoted: false` means
  `priceUsdc: 1` is par by assumption rather than an observation, so do not read it as "the peg is
  holding". USDC itself stays `$1` by definition: it is the numéraire every metric is denominated
  in. Today the market-priced stables are **eUSD** (from the Liquity venue) and **DAI** (local
  deploy); funding never grants either, so any exposure to one is a position somebody chose.

## Oracle Control (Aave v3 / GMX v2)

Mock oracles (`contracts/MockAggregator.sol` / `contracts/MockOracleProvider.sol`) are deployed in setup (in a local deploy they connect to the deployer's venues the same way). For Aave, the coordinator impersonates the ACL admin to point `AaveOracle` at the mock; for GMX, it impersonates `ROLE_ADMIN` to grant the keeper / controller roles and registers the mock provider in `DataStore`. Each round, `updateOracles` writes the fair price into both mocks, moving the health factors of loans and the mark price of perps. Runs that build stress victims in a local deploy calibrate the Aave oracle to the initial fair price before victim setup (see [Market Stress Events](stress-events.md)).

## GMX Async Execution

GMX is async (order creation → keeper execution). In realtime, each block advances via interval mining, and after each block (`afterMine`) the coordinator reads the `OrderCreated` logs of the latest block and executes each order as the keeper. Intra-block ordering is determined by anvil's `--order fees` (descending priority fee). GMX position changes become visible to agents about one block late. GMX actions can only be sent alone (no bundling).

The keeper executes **market orders only** (`MarketSwap` / `MarketIncrease` / `MarketDecrease`, what `gmxIncrease` / `gmxDecrease` create). It also does not execute an order that sets a `callbackContract`, or one that would leave a position over the leverage line ([below](#gmx-leverage-cap-and-liquidation-shortfalls)). A limit, stop or stop-loss order sent with `rawTx` is read, refused and recorded as a `keeper_order_refused` event. It is never executed or retried, even after its trigger price is reached. Its collateral and execution fee stay in GMX's OrderVault, count for nothing while they sit there, and come back only when you cancel the order yourself (`gmxCancelOrder` or `ExchangeRouter.cancelOrder`; GMX allows a non-market order to be cancelled at any time). Why: the keeper tries each order once, in the next block, at a price written before that block is mined, so a stop re-armed every block would fill at the first price of a move that every other order sees a block late.

```mermaid
sequenceDiagram
  participant A as Agent
  participant N as anvil
  participant K as Coordinator (keeper)
  A->>N: gmxIncrease / gmxDecrease (createOrder tx)
  Note over N: block N mined (interval mining)
  K->>N: afterMine — read OrderCreated logs
  K->>N: executeOrder with the oracle price
  Note over A,N: the position change appears in the observation ~1 block later
```

### GMX leverage cap and liquidation shortfalls

**Leverage is capped at ~5.05x** (`MIN_COLLATERAL_FACTOR` = 0.198 for every market; the manifest's
`limits.gmxMaxLeverage` and `obs.protocols.gmx.maxLeverage` / `markets[*].maxLeverage` carry it).
It is measured as size / equity (collateral + PnL + price impact − fees; for an increase or a
withdrawal also size / collateral alone, PnL not counted) at the **execution price**: the oracle price
of the block your order executes in, a block or two after the price you acted on.

**The keeper checks it before GMX does, at 98% of the cap (~4.95x; the manifest's
`limits.gmxKeeperMaxLeverage`).** For every order it is about to execute, it computes the position
the order would leave at the execution price, fees on both ends included. It does not execute:

- an increase (either collateral) that would leave the position above that line;
- a decrease that withdraws collateral and would leave the rest above it (collateral alone is
  counted, so being in profit does not help a withdrawal);
- a partial decrease that would leave the rest above it;
- an increase whose **own collateral** does not carry its own size under that line, whatever the
  position it joins. GMX accepts an increase with size and no collateral; refused, such an add-on
  would lock nothing, so it is refused at every price, and every refused increase locks at least its
  size / ~4.95.

If the keeper cannot read an order or the inputs of its check (a node hiccup), it does not refuse
it: it tries again on the next pass, and refuses only after 3 passes in a row
(`keeper_order_read_retry`).

**An order the keeper does not execute is not refunded.** Like a refused limit order (above), it
stays in GMX's OrderVault, counts for nothing while it sits there, and is recorded as a
`keeper_order_refused` event. A market order can only be cancelled after `requestExpirationTime`
(**300 s = 150 blocks**): send `{ type: "gmxCancelOrder", key }` then (or `ExchangeRouter.cancelOrder`)
to get the collateral and the execution fee back. Your orders still in the OrderVault are in
`obs.protocols.gmx.orders`, each with `cancellable` / `cancellableAtTime`. For example, a WETH-collateral long sized near the cap at the price you observed
is refused if a down gap hits before it executes: the collateral is worth less and the position is
already losing, so the same order is well over the line, and your WETH is locked for 300 s.

Why not let GMX handle it: GMX cancels an over-cap market order and refunds everything in the same
transaction, at no cost (the minimum execution fee is 0 at a tip of 0). An order sized just over the
cap was therefore a free stop order, filled only after the price had moved in its favour and handed
back otherwise, to be sent again the next block. The 2% margin keeps GMX's own check (still there as
a backstop) from ever being the one that decides.

- **The reference runtime does not send** an increase or a collateral withdrawal above **90% of the
  cap (~4.5x) at the price in your observation** (`validate` rejects it with the leverage it computed).
  Leave that room: the price moves between your observation and the execution, by 10% a block inside a
  crash or spike gap. A partial decrease is sent regardless; if it is refused only its execution fee
  waits 300 s.
- **One order per position per block.** A second order on the same position (account, market,
  collateral token, side) in the same block waits for the next block, and is checked against the
  position the first one left.
- An increase with a `swapPath` (collateral swapped on the way in) is refused: the keeper cannot check
  collateral it cannot price before the swap. Post the market's long token or USDC directly.
- Not held to the cap: adding collateral (an increase of size 0) and **a full close, which always
  executes.**
- Liquidation is unchanged: at 1% equity.

Why 5x: the official regimes gap the price by up to 32% (spike, over a 2–3 block ramp, never
recovered), and a liquidation lands a block after the keeper sees it. Below ~8x a losing leg is not
liquidatable after the first of three ramp steps, so a hedged pair cannot have one leg liquidated
early and the other ride the rest of the gap. A 5x position can still close below zero in a large
gap; that shortfall is handled as below.

**A liquidation that GMX closes below zero is charged cross-margin.** GMX lets a liquidation close a
position whose loss exceeds its collateral; the pool absorbs the rest (`InsolventClose`). In scoring,
that shortfall is charged to **the same account's opposite-side positions in the same market**, up to
their PnL — realised (including a winner you already closed) and unrealised — for positions whose life
overlapped the liquidated one. A one-sided position keeps its on-chain limited liability: it loses at
most its collateral. A long + short straddle no longer turns a gap into free PnL. The charge shows in
`summary.json` as `agents[].gmxShortfallChargedUsd` and each close as a `gmx_insolvent_close` event.
