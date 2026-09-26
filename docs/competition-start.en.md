[← README](../README.md) ｜ 日本語: [`competition-start.md`](competition-start.md)

# Getting Started (competition entrants)

**A straight line from nothing to a submittable agent.** §2–§3 get something running in about 30 minutes; §6 onwards is where you keep coming back while you build.

The rules themselves live at [ascon.dev/rules](https://ascon.dev/rules) and are the only source for
them; the Japanese text governs. Where this guide and the rules disagree, the rules win. This guide
only covers how to build. The [Japanese version](competition-start.md) governs this guide too; this
one is a reference translation.

**You need**: Node.js 20 or newer, [Foundry](https://book.getfoundry.sh/getting-started/installation)
(`forge` and `anvil`), `git`, and `zip` (used to build the submission archive).

---

**Contents**: [1. The shape of the competition](#1-the-shape-of-the-competition) ([the blockchain minimum](#the-blockchain-minimum) / [the seven protocols](#the-seven-protocols) / [the 12 regimes](#the-12-regimes) / [timeline](#the-competition-timeline) / [what does not happen](#what-does-not-happen-here) / [what you can do](#what-you-can-do-here-examples)) · [2. Setup](#2-setup) · [3. The smallest agent](#3-the-smallest-submittable-agent) · [4. Observations and actions](#4-observations-and-actions) · [5. LLM strategy revision](#5-llm-strategy-revision) · [6. The development loop](#6-the-development-loop-run-read-fix) · [7. The dashboard](#7-reading-your-results-on-the-dashboard) · [8. Reference agents](#8-the-reference-agents) · [9. Practice devnet](#9-the-practice-devnet-optional) · [10. Submitting](#10-submitting) · [11. Ways people break this](#11-ways-people-actually-break-this) · [12. What to read next](#12-what-to-read-next)

## 1. The shape of the competition

```
the competition
 └ epoch  ×k          One world. Every participant unit starts from identical initial
    │                 conditions at the same moment and runs 360 blocks (2s each = 12 min).
    │                 The world resets between epochs: no inventory, no PnL carries over.
    │
    ├ scenario        The market that epoch replays = (regime, random seed).
    │                 A regime is a type of market condition. Which epoch is which
    │                 regime is not announced in advance.
    │
    └ evaluation interval ×29   A 12-block slice. Used for the leaderboard's running
                                progress. Scoring (P below) uses only the asset value at
                                the first and the last boundary; blocks after the last
                                boundary are not scored.
```

> **360 / 12 / 29 are the code's current values.** Appendix A of the rules lists the blocks per
> epoch, the blocks per evaluation interval, `k` and the gas ETH as **published by the start of the
> submission period (2026-09-23)**. The numbers here come from the official regimes (`blocks: 360`
> in `config/regimes/*.yaml`) and the sdk default (12-block intervals); where the published values
> differ, the rules win.

**Scoring takes exactly one number per epoch.**

```
PnL P    = asset value at the epoch's end − asset value at its start (in USDC)
score T  = 50 + 10 × (P − mean over all units) / standard deviation
final    = weighted mean, later epochs heavier (1.0 at the first, 1.5 at the last)
```

So the competition is **"how did you do against everyone else that epoch", stacked k times**. An
unrealised gain in the middle of an epoch is worth nothing; only the value at the end counts. A
market-wide move is absorbed into everyone's mean, so **you neither gain from a rally nor lose from
a selloff.**

Every unit is handed the same initial capital: **8 WETH + 0.4 WBTC + 25,000 USDC**, plus ETH for
gas. The current official regimes use `economicGas: false`, so that gas endowment is **100 ETH** and is included in scoring.
At ETH=$3,000 / BTC=$60,000 the whole portfolio is about $373,000, roughly 80% of it native ETH;
its market moves therefore contribute heavily to P. ETH is spendable via `rawTx.value`, including
wrapping it or using it as Trove collateral. `sized(obs, "WETH", 1000)` spends **10% of the WETH
balance (initially 0.8 WETH)**, not 10% of portfolio value (about 0.64% at these prices).
One benchmark agent that never moves its capital runs alongside. Every unit runs on the same single chain at the same time.

> **A local `npm run backtest -- --scenarios` ranks with the same rule as the competition** (one scenario = one epoch, P → deviation score T → the later-weighted average; `standings.json`). What differs is the field: locally the population is your roster, in the competition it is every participant. **Local numbers are for comparing your own versions against each other, not for predicting where you will place.**

### What the code calls these

The code uses the rules' words. An **epoch** is `epoch` in the code too: one run, i.e. one
`runs/<id>/` with one `summary.json`. An **evaluation interval** is `interval` in the code
(`valueSeries.intervalSeries` in `summary.json`, `run.intervalBlocks` in the config, 12 blocks by
default), and the dashboard shows it as "Interval". It is not used for scoring.

The code used to call the evaluation interval an `epoch` as well (issue #140). Until the results
are published, `summary.json` also carries the same series under its old name, `epochSeries`, and
the manifest's `round` still has `epochBlocks`. Both mean the evaluation interval.

### The blockchain minimum

If you already know this, skip to [the seven protocols](#the-seven-protocols).

The competition is set in on-chain finance (DeFi), but no real money and no public chain are
involved. There is one chain, run on the organisers' server and shared by everyone, and every agent
trades on it at the same time. These are the only words the rest of this guide needs.

| Word | What it means here |
|---|---|
| chain / block | A single ledger everyone shares. A page (= one block) is appended every 2 seconds, and a written page never changes. The block number is the competition's clock (360 blocks = 12 minutes) |
| wallet | An account number (an **address**, starting with `0x`) together with the **private key** that signs transactions from it. One per agent. The runtime does the signing and sending |
| token | An asset on the chain. Balances are entries in the ledger (table below) |
| transaction (tx) | One instruction, such as "sell 1 WETH into this pool". You sign and send it, and **it only executes once it is included in a block** (usually the next one; when blocks are busy and your fee is low, a later one). Someone else's transaction can land ahead of yours in between |
| contract | A program deployed on the chain. Exchanges and lenders are contracts, and anyone can call their functions. **The rules are the code itself, not a legal agreement**: a call that does not meet the code's conditions is undone partway through (a revert) |
| revert | A transaction that fails a contract's condition (insufficient balance, a worse price than you allowed, …) and is undone. No assets move, but you still pay the fee (the gas used × your priority fee; tiny at the default 0.1 gwei). A transaction already known to fail is stopped by the runtime's simulation before sending and never reaches the chain (logged as `submit_failed`). A revert on chain is one whose conditions broke after it was sent, because of someone else's trade or a price change |
| gas / priority fee | The fee for having a transaction executed, paid in ETH. Here the base fee is 0; you pay only the extra you add to be executed earlier (the priority fee). **Within a block, transactions execute highest priority fee first** (ties in arrival order; one wallet's transactions in nonce order). The environment's reference-price update is sent at a fee above the participants' cap, so it always comes first in the block |
| hash | A transaction's ID (a long string starting with `0x`). Whether your transaction made it into a block is checked by this value |
| nonce | A per-wallet sequence number for transactions. Only one transaction with a given number executes, so sending from the same key in two places makes the numbers collide. The runtime manages it |
| mempool | Where transactions wait after being sent and before landing in a block |
| RPC | The endpoint (a URL) for querying the chain and sending transactions to it. The runtime builds your observation for you, so you never need to call it |
| cheatcode | A special RPC command that only development nodes such as anvil have (`anvil_*` / `evm_*` / `hardhat_*`) and that writes chain state directly — balances, the clock and so on. Prohibited in the competition; strategy code that contains one fails the check (`npm run check:strategy`) |
| reference price (fair price) | The environment's per-block "outside-world price" of ETH and BTC — the equivalent of a major exchange's quote. Prices on the chain's exchanges are not pinned to it and drift away from it (explained under the AMMs below) |
| bps | Basis point, 0.01%. 30 bps = 0.3% |

The tokens:

| Token | What it is | What you start with | Decimals |
|---|---|---|---|
| ETH | The chain's native currency. Gas is paid in it | 100 ETH | 18 |
| WETH | ETH in the same format as every other token. 1 WETH = 1 ETH, convertible either way at any time (wrap / unwrap; there is no dedicated action — call the WETH contract's `deposit` / `withdraw` through `rawTx`). Exchanges trade this one | 8 WETH | 18 |
| WBTC | A token that moves with the price of BTC | 0.4 WBTC | 8 |
| USDC | A token treated as worth exactly $1 (a stablecoin). **The scoring unit**; always counted at $1 | 25,000 USDC | 6 |
| DAI | A stablecoin aiming for $1. Here its price is whatever its pool pays, and it can fall below $1 (regimes `depeg` / `depeg-persist`) | 0 (buy it to hold it) | 18 |
| eUSD | The stablecoin Liquity (below) issues. Priced by its market | 0 (buy it, or borrow it from Liquity) | 18 |
| ERLST | The receipt you get for depositing WETH into the LST (below) | 0 (deposit WETH, or buy it with `lstSwap`) | 18 |

**Amounts are integers in each token's smallest unit.** The chain has no fractions, so 1 USDC is
`1000000` (10^6) and 1 WETH is `1000000000000000000` (10^18); "Decimals" in the table is that
exponent. Action amounts are passed as strings (`amountIn: "500000000"` is 500 USDC), and in
observation field names a `Wei` suffix means 18 decimals and `Units` means USDC's 6. The exceptions:

- An amount with no suffix (`amountIn`, `obs.baseBalances`, `aaveSupply`'s `amount`, GMX's `collateralAmount` and so on) is in the token's own decimals
- A Uniswap LP position's `amountWethWei` / `tokensOwedWethWei` / `uncollectedFeesWethWei` are in WBTC's 8 decimals when the position is in the WBTC/USDC pool
- GMX's `sizeUsd` / `sizeDeltaUsd` are dollars × 10^30 as an integer, and `acceptablePrice` is dollars × 10^(30 − the token's decimals) (10^12 for ETH, 10^22 for BTC). Other `…Usd` fields such as `pnlUsd` are plain dollars
- Aave's `healthFactor` is scaled by 10^18 (1.0 is 10^18; with no debt it is the uint256 maximum), and `…Base` fields such as `availableBorrowsBase` are dollars with 8 decimals

Mix them up and the amount is off by a factor of 10^12 between WETH and USDC, 10^2 between WBTC and
USDC, and 10^10 between WBTC and WETH.

### The seven protocols

A **protocol** is a financial service built out of contracts; the code calls it a **venue**. There
are seven, and each is the code of a well-known real DeFi protocol deployed onto this chain. The core
contracts are the real code, unmodified (the LST alone was written by the organisers). The price
supply (the oracles) and GMX's order execution (the keeper), however, are run by the organisers, and
the addresses and the money inside are separate; nothing connects to the outside world.

| Protocol | Real-world analogue | What you can do here | Main actions |
|---|---|---|---|
| Uniswap V3 / Balancer v2 / Curve | An exchange that prices itself (AMM) | Swap WETH and WBTC against USDC (all three); swap DAI and eUSD against USDC (`stableSwap`); provide liquidity | `swap` / `balancerSwap` / `curveSwap` / `stableSwap` / `mintLiquidity` and others |
| Aave v3 | A lender that takes collateral | Deposit, borrow, liquidate other people's loans (liquidation is `liquidationCall` through `rawTx`) | `aaveSupply` / `aaveWithdraw` / `aaveBorrow` / `aaveRepay` |
| GMX v2 | Margin trading (futures with no expiry) | Bet on ETH and BTC price moves with leverage | `gmxIncrease` / `gmxDecrease` |
| LST | An interest-bearing receipt for ETH | Deposit WETH for yield; trade the receipt | `lstDeposit` / `lstSwap` / `lstRequestWithdraw` / `lstClaimWithdraw` |
| Liquity | Issuing a dollar token against ETH collateral | Borrow eUSD, redeem it, underwrite liquidations | `liquityOpenTrove` and 7 others |

All seven are available in the official regimes, except that `depeg` and `depeg-persist` have no
GMX. Each protocol's state is in `obs.protocols.<name>` (`uniswap` / `balancer` / `curve` / `aave` /
`gmx` / `lst` / `liquity`); the exact shape of each action is in
[protocols-and-actions.md](guide/protocols-and-actions.md).

**Prices come from two places.** Almost every way of making money here comes from the gap between
them.

| Where the price comes from | Where it is used | How it behaves |
|---|---|---|
| The ratio of assets inside an exchange | Trading on Uniswap / Balancer / Curve (and the LST, eUSD and DAI pools); valuing DAI, eUSD and ERLST in scoring | Moves with every trade and drifts from the reference price. The environment's order flow pulls part of a gap back, but not necessarily all of it |
| The environment's reference price (the oracle) | Collateral valuation and liquidation on Aave; fills, margin and liquidation on GMX; collateral valuation, liquidation and redemption on Liquity; valuing ETH and BTC in scoring | No amount of pool trading moves it. It arrives one block late |

#### AMMs (Uniswap V3 / Balancer v2 / Curve) — exchanges that price themselves

An ordinary exchange matches orders: "buy at this price", "sell at that price". An AMM has no order
book. Instead a **pool** holds two tokens (say WETH and USDC); you put one in and the other comes
out, and how much comes out is set by a formula of the balances in the pool (their ratio is the
price, their size the depth).

- **The bigger the trade, the worse the price.** Selling WETH adds WETH to the pool and removes USDC, so each WETH sold is cheaper than the last (price impact, or slippage). The WETH/USDC pools start with about 1,000 WETH + 3M USDC; selling 1 WETH on Uniswap or Balancer fills, before fees, about 0.1% below the pool's price before the trade and leaves the pool's price about 0.2% lower. For 10 WETH it is about 1% and 2%. This thickness of the pool is its **depth**
- **Every trade pays a fee.** The fee pays whoever provided the liquidity (the **LP**), and at the start every LP is the environment. On Balancer the fee is added to the pool's balances. On Uniswap V3 it is not; it accrues to the positions whose price range contained the price when the trade happened (claimed with `collectFees`). On Curve half of the profit earned from fees goes to the pool's administrator (admin)
- **Pool prices are not pinned to the reference price.** The environment's order flow (background buying and selling) has both random-direction trades (which push pools off the reference price) and trades that gradually pull back the part of a gap beyond about 0.3% (capped in size). WETH has three exchange prices and a reference price at once, and **taking the gap between them when it is larger than the fees is arbitrage (arb)**; what the environment leaves open is what arbitrage feeds on. When a trade buys on one exchange and sells on another, each half is a **leg**
- **You can provide liquidity too.** The dedicated actions are Uniswap's `mintLiquidity` / `removeLiquidity` / `collectFees`. On Balancer and Curve's WETH/USDC and WBTC/USDC pools you can become an LP by depositing into the pool directly through `rawTx`, and the LP tokens you receive are valued in scoring as well. You earn fees, but when the price moves your holdings drift towards the losing side

| | Uniswap V3 | Balancer v2 | Curve (twocrypto-ng) |
|---|---|---|---|
| Fee | 0.3% | 0.3% | 0.26–0.45% (higher the more lopsided the pool's holdings; a large trade tilts them itself, so it pays more) |
| WETH/USDC depth at the start | about 1,000 WETH + 3M USDC | same | same |
| WBTC/USDC depth at the start | about 50 WBTC + 3M USDC | same | same |
| Shape of the formula | LPs choose a price range (concentrated liquidity); the starting liquidity covers every range evenly | 50/50 weighted pool, the same shape as Uniswap at the start | Pulls liquidity towards the pool's internal reference price (`price_scale`). While the price is near it, the same depth gives much less price impact; away from it the effect fades and the fee rises. The reference follows the market with a lag |

Curve also has three pools for assets that trade at close to parity (stableswap). Their formula
barely moves near the reference exchange rate and moves sharply once the balance tilts far: USDC/DAI
(100k / 100k), eUSD/USDC (100k / 100k) and ERLST/WETH (100 WETH / about 100 ERLST). The reference
rate is 1:1 between the dollar stablecoins, and for ERLST/WETH it is the redemption rate (how much
WETH one ERLST is worth; see the LST below). These pools set the market prices of DAI, eUSD and
ERLST (the actions are `stableSwap`, `liquitySwapEusd` (or `stableSwap` with `stable: "EUSD"`) and
`lstSwap` respectively).

#### Aave v3 — a lender that takes collateral

A bank deposit and a secured loan in one.

- **Deposit (supply), and borrow another asset against what you deposited (borrow).** For example, deposit 10 WETH and borrow USDC up to a fraction of its value
- **You can borrow only up to a fraction of your collateral's value (the LTV).** Liquidation is judged against a second, slightly higher fraction (the liquidation threshold): the **health factor HF = collateral value × liquidation threshold ÷ debt value**, and once it drops below 1 the position can be liquidated. HF falls when the collateral loses value or the borrowed asset gains it. Borrowing the full LTV against WETH gives HF ≈ 1.03, so a move of about 3% reaches the threshold
- **In a liquidation** a third party repays up to half of your debt (all of it once HF is 0.95 or lower) and receives collateral worth what it repaid plus the liquidation bonus. The liquidator gains and the liquidated account loses. This guide calls a liquidated account a **victim**. The environment never liquidates anyone; other participants do
- **Collateral and debt are priced by the environment's oracle**: WETH and WBTC at the reference price, USDC fixed at $1, ERLST at the reference price × the redemption rate. None of it depends on any pool's price
- **Flash loans**: borrow with no collateral at all, provided you repay the amount plus a 0.05% fee within the same transaction. You need your own contract with the function Aave calls back (`executeOperation`); deploy it with `example/agents/lib/deployContract.ts`. The reference `flash-arb` calls a receiver contract that the environment deploys only under the example config (`run.flashArb: true` in `config/example.yaml`). The official regimes do not deploy it, so there it reverts as it stands
- **Interest over 12 minutes is practically zero.** The chain's clock runs in real time, so deposits do not grow and debts do not swell. The reason to use Aave is what you do with what you borrow, not the interest

You can deposit the four assets below. In actions ERLST is written `"LST"` (`aaveSupply` with
`asset: "LST"`; the observation's `supplied` / `borrowed` use the key `LST` too).

| Asset | LTV | Liquidation threshold | Liquidation bonus |
|---|---|---|---|
| WETH | 80% | 82.5% | 5% |
| USDC | 80% | 85% | 5% |
| WBTC | 70% | 75% | 10% |
| ERLST (`"LST"`) | 70% | 75% | 7.5% |

In practice you can borrow WETH and USDC. WBTC borrowing is enabled, but Aave holds no WBTC at the
start, so there is nothing to borrow until someone deposits some. ERLST is collateral only and
cannot be borrowed. Borrowing by itself does not change your asset value: what you borrowed is in
your wallet and the same amount of debt is subtracted. In the `lending-incident` regime the
organisers open two borrowers at HF 1.10 and then crash the reference price, which creates
liquidations to take. Liquidation is not a dedicated action: send Aave's `liquidationCall` through
`rawTx` (`example/agents/lib/aave-liquidation.ts`). The victims' addresses arrive in the environment
variable `ERIS_LIQUIDATION_VICTIMS`. The reference `liquidator` is in the `run(ctx)` form, so it
cannot be submitted as it stands. The state is in `obs.protocols.aave`: `healthFactor` (scaled by
10^18) / `supplied` / `borrowed` / `availableBorrowsBase` (dollars with 8 decimals).

#### GMX v2 — margin trading (perps)

A way to bet on the price of ETH or BTC without buying any (a perpetual: a future with no expiry).

- **Post margin and hold a position several times its size (leverage).** For example, a 5,000-dollar ETH **long** (gains when the price rises) on 1,000 USDC of margin makes +$50 when ETH rises 1% and −$50 when it falls 1%. A **short** (gains when the price falls) works the same way. Margin is WETH or USDC on the ETH market (`base` omitted) and WBTC or USDC on the BTC market (`base: "WBTC"`). WETH margin is sent from your native ETH balance, not from your WETH tokens (the same balance that pays the execution fee)
- **The price is the reference price.** That is why offsetting WETH bought on an AMM with a GMX short (a **hedge**) removes your exposure to the reference price and leaves only the AMM's mispricing (`basis-arb`). Until the hedge is filled, though — a block or more — the exposure is not offset. Post the short's margin in USDC (WETH margin itself carries ETH's price moves)
- **Orders execute in two steps.** Your transaction only places the order; the position exists once the environment's keeper processes it in a later block, and the observation shows it later still. **Re-sending the same order before it shows up opens it twice**
- Every order carries 0.03 ETH as an execution fee (the runtime attaches it); what is not used is refunded when the order executes
- **Position fees, borrowing fees and price impact are 0 here** (on the real GMX, opening or closing costs 0.04–0.06% of the size). The only costs are the unrefunded part of the execution fee (tiny) and funding; the +$50 example above assumes this
- **Funding**: a fee the crowded side (longs or shorts) pays the other. The rate moves gradually with the skew, so after the skew flips the side that was paying keeps paying for a while. The sign of `fundingPerHourBps` tells you who pays now (positive = longs pay). Here it comes to less than 0.01% of the position over 12 minutes — one cost among several, not a source of income

The state is in `obs.protocols.gmx`: `marketPriceUsd` / `position` (`sizeUsd` in dollars × 10^30 as
an integer; `pnlUsd` / `entryPriceUsd` in plain dollars) / `longOiUsd` / `shortOiUsd` /
`fundingPerHourBps`. The BTC market has the same shape under `markets["WBTC/USDC"]`.

#### LST — an interest-bearing receipt for ETH

Deposit WETH into the vault (the contract that holds it; `lstDeposit`) and you receive the receipt
token ERLST — the same design as Lido's wstETH in the real world.

- **The WETH one receipt can be redeemed for (the redemption rate) grows slowly with interest.** The rate is 3% a year, and interest here counts each block as one hour, so one epoch (360 blocks = 15 days' worth) adds about 0.12%
- **There are two ways to cash out, at two different prices.**
  - Withdraw from the vault (request with `lstRequestWithdraw`, wait, then `lstClaimWithdraw`): the full amount, fixed at the redemption rate at the moment you request (no interest accrues while you wait). But you join a queue. The wait is the longer of 24 blocks and the time for the requests ahead of you to clear, plus one block per WETH of your own request, rounded up (32 blocks for 8 WETH even with an empty queue)
  - Sell on Curve's ERLST/WETH pool (`lstSwap`): immediate, but the fee (0.04% and up) and price impact mean you receive less than the redemption rate. When the pool's mid sits below the redemption rate, the gap is the **discount** (`discountBps`). Only participants trade this pool, so the discount opens when someone sells a lot
- **In scoring, ERLST still in your wallet when the epoch ends counts as what selling all of it into the pool pays at that moment. A withdrawal you requested counts in full if it is claimable by then (you need not have claimed it), and as 0 if it is not.** "The end" here is the last evaluation-interval boundary — with the current values, the block where `obs.blocksRemaining` reads 12, not where it reaches 0
- You can also lever up: post ERLST on Aave, borrow WETH, deposit it into the vault for more ERLST (`lst-carry` does this only when `ERIS_LST_LEVERAGE_TARGET_HF` is set)

The state is in `obs.protocols.lst`: `redemptionRateWeth` (the redemption rate) / `marketPriceWeth`
(the pool's price) / `discountBps` / `estimatedQueueDelayBlocks` (the wait to withdraw everything you
hold) / `instantExitWethWei` (what selling into the pool pays right now).

#### Liquity — issuing a dollar token against ETH

Deposit ETH as collateral and borrow newly issued eUSD, a dollar token. The borrowing account is a
**Trove** (the real Liquity V1 code, unmodified).

- **Your collateral ratio (ICR = collateral value ÷ total debt) must stay at 110% or above**; below it, anyone can liquidate you. The total debt is the eUSD you received plus the borrowing fee plus the 200 eUSD deposit (borrow 2,000 eUSD and it is about 2,210 eUSD). Collateral is priced at the reference price
- **Redemption: 1 eUSD can always be exchanged for $1 worth of ETH (at the reference price).** If eUSD trades below $1 by more than the redemption fee plus the cost of turning the ETH back into USDC (together a little over 0.8%), buying it and redeeming is profit. The redemption fee is 0.5% or more, rises with every redemption and barely comes back down within an epoch. The ETH comes out of **the lowest-ratio Trove among those at 110% or above** (Troves below 110% are skipped). From the borrower's side, $1 of collateral is taken without asking for every eUSD redeemed, and the same amount of debt disappears. At the reference price the net worth is unchanged, but scoring counts the debt at eUSD's market price, so being redeemed while eUSD is cheap costs you exactly that discount (`redemption-arb` takes, `trove-manager` defends)
- **Stability Pool**: deposit eUSD to absorb the debt of liquidated Troves, receiving their ETH collateral at a discount (`sp-underwriter`)
- **Recovery Mode**: when the system-wide collateral ratio (TCR) falls below 150%, a Trove at 110% or above but below the TCR can be liquidated, but only when the Stability Pool can absorb its whole debt. It loses collateral worth at most 110% of the debt, and the rest can be claimed afterwards (`claimCollateral()` on BorrowerOperations, through `rawTx`). During Recovery Mode the borrowing fee is 0, and you can neither close a Trove nor withdraw collateral. The TCR is set by everyone's Troves, so your line can move even when your own ratio does not (`liquidationPriceUsd` stays on the 110% basis)
- The collateral inside a Trove is ETH itself, not WETH. Actions specify it as a WETH amount, and the runtime unwraps the WETH before posting it, so your gas ETH is untouched. The other way round, closing a Trove, withdrawing collateral, redeeming and Stability Pool gains all **pay out in ETH**. To use it on an exchange you have to wrap it back into WETH; there is no action for that, so call WETH's `deposit()` through `rawTx` (as `redemption-arb` / `sp-underwriter` do)
- Borrowing costs a fee of 0.5% or more, and 200 eUSD is added to the debt as a deposit (it pays whoever liquidates you, and comes back if you close the Trove yourself). The minimum loan is in `minNetDebtEusdWei`

At the start there is the organisers' Trove (350 ETH / 350k eUSD, about a 300% ratio), the eUSD/USDC pool
(100k / 100k) and the Stability Pool (125k eUSD). In `cdp-incident` the organisers open two Troves at
120%, then lower the reference price and sell eUSD below $1 at the same time. The state is in
`obs.protocols.liquity`: `trove` (`icr` / `liquidationPriceUsd` = the ETH price at which it gets
liquidated) / `marketPriceUsdc` (eUSD's market price) / `redemptionEdgeBps` (the discount minus the
redemption fee; the cost of turning ETH back into USDC is not included) / `recoveryMode`.

#### How holdings are valued in scoring

The scoring code counts the asset value of rules §4.1 for each kind of holding like this. "The end
of the epoch" is the last evaluation-interval boundary (see the diagram in §1). Marks that come from
a pool's price (DAI, eUSD, ERLST, Liquity) are the median over the 5 blocks up to and including the
valuation block (rules §4.1). Rows the rules do not spell out say so.

| Holding | Counted as |
|---|---|
| Token balances | ETH, WETH, WBTC at the reference price; USDC at $1. DAI and eUSD at the geometric mean of the pool's sell and buy quotes ($1 when no quote comes back). ERLST: see the LST row. Any other token (LQTY, the `launch` listings and so on) is 0 (rules §4.1) |
| AMM liquidity | A Uniswap position is what it holds at that moment (two tokens) plus uncollected fees. LP tokens of the Balancer and Curve WETH/USDC and WBTC/USDC pools are your share of what the pool holds (stableswap LP tokens are 0) |
| Aave | Collateral − debt at Aave's oracle prices; negative when the debt exceeds the collateral. ERLST collateral is re-counted like the LST row, at what selling it into the pool pays (capped at its value at the redemption rate) |
| GMX | Margin + unrealised PnL from the price move (at the reference price). Accrued funding is not deducted. An order not yet executed counts as 0, its margin and execution fee included (an order placed just before the end is one) |
| LST | ERLST in your wallet is what selling all of it into the pool pays at that moment. A requested withdrawal counts in full if it is claimable by then (you need not have claimed it), and as 0 if not (the rules do not spell this out; it is the scoring code's rule) |
| Liquity | A Trove is its collateral (at the reference price) minus the cost of buying back its net debt (the debt without the 200 eUSD deposit) in the pool now, floored at 0 since you can walk away from the debt by abandoning the collateral. Surplus collateral left over from a redemption or liquidation counts at the reference price. The Stability Pool is what selling your eUSD balance after absorbed liquidations pays in the pool now, plus the ETH not yet withdrawn. LQTY is 0. Rules §4.1 does not name CDPs; this is the scoring code's rule |
| Assets inside a contract you deployed | 0. Scoring counts only the balances and positions your agent's own address holds, so a contract's contents are not counted even when they are WETH. Profit that passed through counts in full (the rules do not spell this out; it is the scoring code's rule) |

### The 12 regimes

These are the eight kinds rules §3.2 publishes plus `spike` (issue #105), `depeg-persist` (issue #106), `cdp-incident` (issue #107) and `launch` (issue #29); the rules' list needs all four additions. Which epoch is which regime is never announced, but
**the kinds themselves and their generators are public**: `config/regimes/<name>.yaml`. The public set
`config/scenarios/public.yaml` is 12 regimes × 5 seeds = 60 scenarios; the non-public set is drawn from
the same family, of which only the perturbation ranges are published (rules §3.3). The numbers in the
table are the current YAML ranges; where the published values differ, the rules win.

Words the table uses:

- **Window**: the stretch during which an event is on, written as block counts for ramp (building up) → hold (held at full strength) → decay (fading back)
- **Mean-reverting walk**: a price that moves randomly each block but is pulled back harder the further it strays from its level. A **drift** is a lean in one direction; a **gap** is a sudden move that skips the prices in between
- **Mid**: the midpoint of what a pool pays to buy and to sell right now; read it as the pool's price
- **Par**: the price something is supposed to have — $1 for a stablecoin
- **β**: the part of your PnL that simply follows the whole market up or down. It reflects what you hold and how much, not how well you trade
- **Dry-run**: simulating a transaction to see its result before sending it
- Trove, ICR, MCR and redemption are under Liquity; HF, victim and liquidation under Aave; depth under the AMMs ([the seven protocols](#the-seven-protocols))

| # | Regime | What the environment does | Reference agents written for it (§8) |
|---|---|---|---|
| 0 | Calm `calm` | No events. The reference price is a mean-reverting walk, the order flow neutral | `venue-arb` / `multi-arb` / `stat-arb`. The baseline for arbitrage: a strategy that loses here loses everywhere |
| 1 | CEX drift `cex-drift` | While a window is open the reference price carries a drift (0.1–0.2% per block) and mean reversion weakens. Three windows; one of them does not give the level back when it closes. Pool prices keep diverging from the reference | The cross-venue arbitrageurs get work. A directional `levered-long` swings hard on β |
| 2 | Informed flow `informed-flow` | The environment's order flow leans one way while a window is open (2–3× size, correlation 1.0, 12-block persistence; two windows). Hard to tell from calm | `stat-arb` / `multi-arb` |
| 3 | Whale `whale` | A single 25–60 WETH order knocks a pool's mid. Four of them, two pinned to Balancer / Curve. The reference price does not move | `venue-arb` / `multi-arb` / `max-profit-arb`. Whoever takes the dislocation first wins it, so bidding priority fee matters |
| 4 | Lending incident `lending-incident` | The reference price falls 12–16%, in the same window every AMM loses 40–60% of its depth, and two victim accounts opened at HF 1.10 become liquidatable on Aave | `liquidator` (the one liquidating) / `levered-long` (managing not to be the one liquidated) |
| 5 | Stablecoin depeg `depeg` | The environment sells DAI into the USDC/DAI pool (35–60% of its depth; ramp 12 / hold 36 / decay 45 blocks) and opens a discount. **No GMX (nor in `depeg-persist`)** | `peg-arb`. DAI has no redemption floor, so the question is whether you believe it comes back |
| 6 | Crash `crash` | The reference price gaps 15–22% and liquidity is pulled 40–60% in the same window. No victims are opened | Everyone. Arbitrage shrinks in a thin book and leverage crosses its HF. `trove-manager` / `sp-underwriter` handle the same moment on the Liquity side |
| 7 | New pools `vuln` | Mid-epoch, 4–6 pools appear, twice; 50–70% of them skim assets from any trade above a size (4–8% of the USDC endowment). The bait is a 3–6% discount | `discovery-arb-verify` (dry-runs before taking) / `discovery-arb` (the unverified control) |
| 8 | Spike `spike` | The reference price gaps 15–22% **up** and liquidity is pulled 40–60% in the same window. Crash's mirror; no victims are opened | Everyone. The one regime where merely holding the basket is rewarded and a hedge or a short pays; the arbitrage runs the other way round from crash, so it needs USDC inventory |
| 9 | Persistent depeg `depeg-persist` | The environment sells DAI as in `depeg` (35–60% of depth; ramp 12 / hold 36) and then **does not buy it back**: the discount stands through the last scored block, the buy-back comes after scoring | `peg-arb`. In `depeg` waiting for par was right by construction; here whatever was bought on the belief that par returns is valued at the discount at the end. The one regime that separates judging the return from assuming it |
| 10 | CDP incident `cdp-incident` | The environment opens two Troves at ICR 1.20, the reference price falls 12–16% (depth pulled 40–60% in the same window), and in the same window it sells eUSD into its pool. The Troves cross MCR 1.10 and eUSD trades below par | `sp-underwriter` (absorbs through the Stability Pool and liquidates), `redemption-arb` (buys cheap eUSD and redeems against the victims), `trove-manager` (keeps its own Trove out of the redemption path and above MCR) |
| 11 | New listings `launch` | Mid-epoch (0.2–0.5) the environment lists 2–3 new tokens at 1.00 USDC in USDC pools (20k–100k USDC a side); they appear in the list of new markets (the registry, `obs.registry`) as `uniswapV3Pool` + `erc20` a block later. Per token, independently, a demand wave follows (starting two blocks after the listing, 0.25–1× the pool's USDC bought over a 20-block ramp, held 30, 50–100% sold back over a 30-block decay) or, with 30–50% probability, does not (a dud). Nothing is announced; the ramp's first blocks are the only signal. **Listed tokens still held when the epoch ends are valued at zero** (rules §4.1) | `launch-confirm` (enters after several blocks in a row where buying outweighs selling, exits once selling outweighs buying) / `launch-sniper` (buys at first sight and sells after a fixed hold — the control) |

Three notes.

- **The seed decides where an event lands.** `windowFrac` is a range for where in the epoch it falls, so
  the same regime lands in different places under different seeds. The observation does not carry the
  window positions (§4)
- **Fitting one regime is paid for in the others.** The deviation score absorbs the difference in
  roughness between regimes, so all 12 weigh about equally on the score. A strategy that wins big in
  `lending-incident` and loses in the other 11 places below a steady one. The regime columns of the
  standings and the per-regime table on an agent's page show exactly that (§7)
- **In regime 7, neither "never look" nor "take everything" is optimal** (the note under rules §3.2). Some
  of the pools that appear are honest and the discount is real

### The competition timeline

The schedule of rules §1 (Japan Standard Time), with what you do at each stage.

| When | What happens | What you do |
|---|---|---|
| 9/1 – 10/24 | Registration period | Join the ASCON channel on the Discord and submit the registration form |
| 9/23 | The submission period opens. Appendix A's values (epoch length, evaluation interval, k, gas ETH), the inference proxy's model list and the list of permitted exploit targets are published **by this day** (rules §7.1) | Work through §2–§6 of this guide |
| 9/23 – 10/31 | **Submission period.** Evaluate yourself on the 60 public scenarios and replace your submission **up to 5 times a day**. In the same period the operator's **trial environment** (rules §2.7) is open: the same configuration as the competition, take any transaction you like, but **no standings are posted** and nothing counts | Build → run → fix (§6). Submit the `bundle:agent` zip (§10) |
| 10/31 | **Submission deadline = the agent is frozen.** Nominate up to 2 submissions for final evaluation. The hash of the lottery seed is published | No more code changes |
| 11/1 – 11/7 | **Live competition.** One epoch is one unit; k of them, the world reinitialised each time, every unit starting at once. Score and cumulative standings update after every epoch | **You operate nothing.** Your agent runs in the operator's container and the only thing that moves is the in-epoch LLM revision. Watch the standings on the dashboard (§7) |
| 11/8 | Reserve day, for the same-seed re-run of an epoch that failed on the operator's side (rules §4.4.2) | — |
| 11/9 – 11/30 | Review period: audit of violations, review of the report track (entries due 11/21), the standings are finalised. No new epochs run | Enter the report track by 11/21 if you want to |
| 12/7 | Results. After a 7-day objection period the run directories, decision logs and the lottery seed's original are published in full (rules §7.2) | — |

**What you see during the live week** is whatever part of the standings, the scenario page and the agent
pages can be shown without breaking a competition in progress. Which epoch is which regime is withheld
(it says only `epoch s`), decision logs and raw LLM exchanges are 404, the event schedule and the seed
are dropped. The table at the end of §7 lists it.

### What does not happen here

The more mainnet (production public chain) experience you have, the more you design around things
that this environment does not have. None of the following exists here. **If blockchains are new to
you, skip this section**: each item is "a problem on mainnet that does not arise here".

- **Reorgs (a written block later replaced by different contents) and unconfirmed blocks.** The chain is a single Anvil node on interval mining. A block is
  final the moment it is mined; it does not roll back and a mined transaction does not disappear. The
  world is rebuilt only at the start of an epoch (rules §4.7.1) — that is an initialization, not a reorg
- **Gas price spikes.** The base fee is pinned at 0. What you pay is the priority fee you choose to
  stack (default 0.1 gwei, capped by `obs.limits.maxPriorityFeePerGasWei`); other people's congestion
  never raises your bill. Gas ETH is part of your asset value (rules §4.2), so fees do reach the PnL
- **An edge from arriving first.** Order within a block is by priority fee, highest first (rules §2.6;
  Anvil runs with `--order fees`). A faster line or an earlier call wins nothing — if you want the
  position, bid for it
- **Enumerating pending orders through RPC.** With `RPC_FILTER=1`, the participant gateway refuses
  pending transaction lists/filters and block, transaction and receipt reads with the `pending` tag.
  `eth_getTransactionCount(address, "pending")` remains available for sender nonce management.
  See the [gateway policy and measurements](../infra/rpc-gateway/README.md). This applies at the
  gateway; local runs pointed directly at Anvil do not get this filter.
- **Rewriting the reference price or an oracle.** `PriceFeed`, the Aave aggregators and the GMX oracle
  provider are owner-gated, and at startup every privileged write is simulated by `eth_call` from an
  address with no role to measure that the gate holds (`core/src/realtime/ownerGuards.ts`). Move a
  pool as far as you like: the marks for WETH / WBTC and the liquidation prices at Aave and GMX do not
  follow (they come from the environment's price). Assets marked from a market — stablecoins, the LST,
  eUSD — can be moved, but the mark is the median over the previous 5 blocks (rules §4.1), and trading
  to distort a mark is a prohibited act (rules §8)
- **Direct manipulation of chain state.** The RPC gateway answers 403 to every method outside `eth_` /
  `net_` / `web3_` (`anvil_*` / `evm_*` / `hardhat_*` / `txpool_*` / `debug_*`;
  `infra/rpc-gateway/README.md`). There is no way to write a balance or a storage slot, and no
  `eth_sendTransaction` either — you sign locally
- **Operator intervention mid-epoch.** During an epoch the environment does exactly this: the
  per-block reference price update, the background order flow, execution of GMX orders, and the
  events the 12 regimes define. The only other hand on the wheel is the
  voiding and same-seed re-run of an epoch that failed on the operator's side (rules §4.4.2), and the
  PnL of an epoch that did not finish never reaches the standings
- **Disqualification or penalties for going bust, timing out or crashing.** Each of those is just a
  PnL that becomes a deviation score (rules §4.4.2, §4.5). Blocks do not wait for an agent's answer
  (rules §2.3), so a slow strategy never stalls the chain either
- **Real-world losses.** Every asset exists only inside the competition environment and has no value
  or convertibility outside it (rules §0.2)

### What you can do here (examples)

Conversely, things that capital or permissions make hard to try on mainnet are ordinary here. The
reference agents live in `example/agents/`. **These are advanced examples; your first agent needs none
of them.**

- **Deploy (place on the chain) your own contracts.** A `rawTx` with no recipient (`to` omitted)
  carrying compiled code (a forge artifact) is a deployment
  (`example/agents/lib/deployContract.ts`; the forge artifacts ship inside the submission zip). An
  atomic (either everything succeeds or everything is undone) arbitrage across several venues is written as your own contract this way (rules §0.1: a
  bundle guarantees no atomicity). Aave flash loans are enabled (you deploy the receiving contract
  yourself; the Aave section covers the reference `flash-arb`). **But whatever is still inside your
  contract when the epoch ends is valued at 0** (scoring counts only the balances and positions your
  agent's own address holds; the rules do not spell this out, it is the scoring code's rule). Profit that passed through counts in full, so
  withdraw before the epoch ends
- **Make a market, provide liquidity.** You can create a new Uniswap V3 pool (`createPool`). Adding to
  an existing pool works the same way (`mintLiquidity` / `removeLiquidity` / `collectFees`; see
  `lp-provider`). The environment's order flow never visits a pool you made, so your counterparties are
  other participants only. The official regimes other than `launch` carry no list of new markets (the registry,
  `obs.registry`), so another
  participant finds your pool only by reading the chain themselves. Permissionless lending
  (`createLendingMarket`) exists only in the verification regime
  (`config/regimes/agent-markets.yaml`)
- **Deploy a vulnerable contract on purpose, attack someone else's.** Exploiting weaknesses in other
  participants' agents, contracts and the market structure is part of the competition (rules §8; the
  permitted targets are the operator's protocols and other participating units — rules §3.1). See
  `vault-keeper` (deploys a `LeakyVault` whose withdrawal function `rescue()` was left callable by
  anyone and puts USDC in it) and `exploit-hunter` (recovers function identifiers, or selectors, from
  the bytecode — the compiled code on the chain — of someone else's unknown contract and drains it in
  one transaction). Measured: hunter +9,999.9 / vault-keeper −10,000.2 — the whole 10,000 USDC deposit
  moved. With no registry in the official regimes other than `launch`, the hunting side scans the chain
  itself. The environment's own contracts, by contrast, are measured at startup to confirm that
  writes only their owner may make are closed to everyone else. Moving
  assets between your own two submissions is self-dealing and prohibited (rules §8)
- **Liquidate and redeem other people's positions.** Aave's `liquidationCall` through `rawTx`
  (`liquidator`), Liquity's `liquityLiquidate` and Stability Pool underwriting (`sp-underwriter`),
  eUSD redemption (`liquityRedeem`; `redemption-arb`)
- **Use leverage.** GMX perps (`gmxIncrease` / `gmxDecrease`; orders are executed by the environment's
  keeper from the next block on), Aave borrowing, a Liquity Trove, borrowing WETH against ERLST
  (`lst-carry`)
- **Buy your position in the block.** Bid with `maxPriorityFeePerGasWei` on the action. The highest fee
  anyone else paid in the most recent block is `obs.competition.maxCompetitorPriorityFeeWei`
- **Inspect a pool that appears mid-epoch before touching it.** In regime 7 the operator places pools
  during the epoch, some of which skim assets (rules §3.2). `obs.discoveredPools` carries the address,
  the code hash (a fingerprint of the code: the same code gives the same value), the reserves and a
  price. `discovery-arb-verify` dry-runs before taking; `discovery-arb` takes
  without checking. Measured: unverified −5,306 / verified +721
- **Rewrite the strategy while it runs.** As in §5, the LLM revises the code outside the trade path

---

## 2. Setup

```bash
git clone <repo> && cd eris-competition-poc
npm install
cp config/example.yaml config/local.yaml   # run config + roster
cp .env.example .env.local                 # keys and RPC (Anvil's dev keys are fine locally)
npm run build:contracts                    # forge build PriceFeed + mock oracles (once)
```

What the next steps do, first. **anvil** is a test chain that runs on your own machine (it comes with
Foundry). **Deploying** places the seven protocols' contracts on that chain and writes where they
landed to `deployments.json`. `gen:local-constants` brings those addresses into the sdk your agent
uses, and `gen:state-dump` saves the whole chain state right after the deploy (the §6 backtests start
from that state every time, so you never redeploy). `sim:realtime` is one run of your agents on that
chain. The keys in `.env.local` can stay as the public test keys anvil ships with when you run locally.

Deploy every venue onto a local anvil (the first run takes a few minutes to fetch the GMX clone).

```bash
# --- terminal A (first time only) ---
cd deployer
npm install && forge build
cp .env.example .env
./scripts/setup-vendors.sh
```

**The deploy runs in a terminal of its own and stays there.** `npm run deploy` **deliberately never
exits**, because it is what keeps anvil alive (`deployer/src/index.ts`). Anything written after it in
the same block never runs.

```bash
# --- terminal A (the deploy; leave this open) ---
cd deployer && npm run deploy -- --keep-fresh
```

Once it logs that the deploy finished, carry on in **a second terminal**.

```bash
# --- terminal B ---
npm run gen:local-constants               # deployments.json → sdk/src/constants.local.ts
npm run gen:state-dump                    # create backtest/state/ for §6 (not included in git)
npm run sim:realtime
```

A `runs/<id>/` directory appears; if `summary.json` holds a result per agent, you are set up.

> **Redeploying means rebuilding the anvil too.** `--keep-fresh` only removes `deployments.json`;
> running it twice against the same anvil fails at the WETH wrap with `insufficient funds`.

---

## 3. The smallest submittable agent

For Python, copy `example/agents/my-arb-py`: `strategy.py` plus `prompt.md` (`kind: improve`,
`language: python`) uses the same runtime and submission ZIP as TypeScript below. Locally run
`python3 -m venv .venv`, then `.venv/bin/python -m pip install ./sdk-py`, and set
`ERIS_PYTHON="$PWD/.venv/bin/python"`. The container includes Python 3.11.16. See the
[Python guide](guide/python-agents.md) for the SDK, dependencies and protocol.

**One agent is one directory.** Copy the template.

```bash
cp -r example/agents/my-arb example/agents/my-strategy
```

It holds two files. **The runtime starts an agent with only `agent.ts`, but rules §2.5 requires
`prompt.md`, so a submission needs both.** (An agent with no `prompt.md` runs normally in local
testing; what fails at startup is a `prompt.md` that exists **without** `kind: improve`.)

```
example/agents/my-strategy/
  agent.ts     the strategy, which trades on every block
  prompt.md    how an LLM should rewrite the strategy (required by rules §2.5)
```

**Creating the directory does not start anything.** Add the id to the roster in
`config/local.yaml`.

```yaml
agents:
  - id: my-strategy          # points at example/agents/my-strategy/
    wallet: AUTO
```

Now `npm run sim:realtime` spawns your agent. `wallet: AUTO` derives the agent's wallet key from its
id automatically (the environment hands it the starting capital). To use an id that differs from the directory name, name
the directory with `dir:` — that is how you run one strategy several times with different parameters.

### `agent.ts` — the strategy

```ts
import type { AgentAction, AgentObservation } from "@eris/sdk";

export function decide(obs: AgentObservation): AgentAction | null {
  return { type: "noop", reason: "not doing anything yet" };
}
```

That is the whole contract.

- If you return an action, the runtime **validates it before** signing and sending, in two stages.
  Something malformed enough to fail the required format (the schema) is logged as `bad_action` in
  `agents/<id>.jsonl`; something that parses but does not validate (not enough balance, say) is
  `rejected`. **Neither kind of failure reaches the chain** (fail-closed: when in doubt, do not send)
- Returning `null` skips the round. **Doing nothing is a perfectly good answer** — not trading in a
  market with no opportunity is correct
- Throwing does not break the run: that round is skipped and `decide error:` is logged

> **Write a submission as `decide()`.** The runtime also accepts `run(ctx)` in place of `decide`, for
> an agent that owns its own loop (see `liquidator`) — but **`run(ctx)` and `prompt.md` cannot
> coexist**: self-improvement works by swapping out `decide`, so an agent with both exits 1 at
> startup (`example/agents/runtime/bot.ts` says so in its error). Since rules §2.5 makes `prompt.md` mandatory, the
> `run(ctx)` form cannot currently be submitted.

Pools are not pinned to fair. Background arbitrage stops inside the `informedArbFeeBps: 30` cost
band; sizing, liquidity, ordering and inventory can leave wider residuals. Tens of bps from fair
alone do not establish profit: include round-trip fees, price impact and inclusion delay.

### `prompt.md` — the revision policy

**The frontmatter needs `kind: improve`. Without it the run fails at startup.**

```markdown
---
kind: improve
name: my-strategy
description: one line describing the strategy
reviseEveryBlocks: 60
---

This file is not "what to do with this observation". It is **when, on what evidence, and how the
strategy code should change**.

## What this strategy is built on
(the assumptions the LLM must not break)

## What may change, and what may not
(thresholds and sizing yes; the ordering of a two-leg execution no)

## Evidence for a revision
- `transactions since the last revision`: separate successes, reverts and unmined transactions; read mean inclusion latency, position in the block, and trading gains separately from market moves on inventory.
- `market history`: check each venue's gaps, fees and event windows across the interval.
- `recent decisions`: match decisions to rejected, failed and included transactions.
- `latest observation`: check current inventory and executable opportunities.
Leave the strategy alone if evidence is insufficient or the loss is only a market move.

## Reply
Return JSON only. Keep the code with {"notes":"evidence", "executorTs":null}.
To revise it, put the decide function body in executorTs as a string.
To undo a revision, select a version from the history, e.g. {"notes":"evidence", "revertTo":0}.
```

> **Why the marker exists.** There used to be a `prompt.md` under the same name that said "what to do
> with this observation", with the same frontmatter keys. `kind: improve` is the only thing that
> tells them apart, so one without it is rejected rather than read — reading it would put trading
> instructions into a system prompt as though they were a revision policy.

`reviseEveryBlocks` is how often a revision is attempted (default 60 blocks). **The first observation
is kept as the baseline and does not trigger one** — otherwise a revision would be spent before the
strategy had any record to reason about. So 360 blocks span 359, and the default gives **5 attempts
per epoch**.

---

## 4. Observations and actions

`obs` is a **snapshot of confirmed state** that the runtime rebuilds every block. You never hit RPC
yourself (§1's glossary).

```ts
obs.fairPriceUsdcPerWeth        // the reference price the environment publishes (on-chain PriceFeed)
obs.protocols.uniswap.pool      // per-venue state
obs.balances                    // your balances; stables come itemised
obs.limits                      // default/max priority fee and default slippage. No size caps in here
```

**What the observation does not carry**: unconfirmed orders, the next block, where the event windows
are. Everyone sees the same things with the same delay (writes to `PriceFeed` land in the next block,
so the reference price is always one block behind).

**The highest competitor priority fee in the most recent block is observable**
(`obs.competition.maxCompetitorPriorityFeeWei`); it is mined history. `ctx.publicClient` permits
additional read-only chain queries. There is no `ctx.walletClient`: return an action or use
`ctx.submit({ type: "rawTx", tx })` for transactions. Sending through a separate client on the same
key races the runtime's nonce and bypasses its `submitted` records. Keep all sends in the runtime.
Rules §8 define prohibited conduct.

`decide()` runs in a worker thread (a thread separate from the runtime itself) with a **5-second
deadline owned by the runtime**. Synchronous infinite
loops and unresolved awaits both produce `decide timeout:`; the result and all queued `ctx.submit`
actions from that call are discarded. The next decision reloads the selected strategy in a new
worker. Worker-local variables reset; the parent observation and revision loops, nonce, logs,
version history and state directory continue. **The no-restart provision in rules §2.3 concerns a
terminated agent process.** Replacing computation inside a live process neither restarts that agent
nor automatically rolls its strategy back. Self-driven `run(ctx)` agents retain their own lifecycle
and do not have a per-decision deadline.

**There is no order-size cap.** No venue has a per-order amount cap, a bundle-length cap or an
open-position cap, and `obs.limits` carries no size budget (the former `maxWethInWei` /
`maxUsdcInUnits` / `maxBundleActions` / `maxOpenPositions` were removed on 2026-09-02 — removed,
not raised). The only bounds on a trade are **your balance** and **the depth of the pool you trade
into**; the bigger you go, the worse the fill. Size yourself. The shared helper is
`sized(obs, token, bps)` in `example/agents/lib/affordable.ts`, a fraction of what you hold.

**There are two kinds of limit and they bite differently.**

| Where it comes from | What it caps | What happens if you exceed it |
|---|---|---|
| the runtime (validates before sending) | the action's shape and content (schema; a leg you hold no inventory for), the priority fee (`obs.limits.maxPriorityFeePerGasWei`), **gas** (30,000,000 per transaction, 30,000,000 per agent per block in total) | **rejected** before signing, with a `rejected` entry and its reason in `agents/<id>.jsonl` (for gas: `tx gas cap` / `per-block gas budget`). Nothing reaches the chain |
| rules §2.3 and §2.6 (the operator imposes it) | **5,000 ms** per decision, **2 vCPU / 4 GB** of memory (§2.3). **No cap on transactions per block** (§2.6: inclusion is decided by the priority-fee auction, and the block gas limit is 30,000,000) | a timeout is no action for that block; a crash is no action for the rest of the epoch (no restart). **None of this is in `obs.limits`** |

The runtime enforces send validation and the decision deadline. Design your agent to operate within
the CPU and memory allocation.

The action catalogue is in [protocols-and-actions.md](guide/protocols-and-actions.md); every field of
`obs` is in [writing-agents.md](guide/writing-agents.md).

---

## 5. LLM strategy revision

Python revisions return the **complete strategy.py** in `executorPy`. The host runs the static
check and a one-second `python3 -m py_compile` before installation; the next decision selects the
new process. `executorPy: null` keeps the strategy, and `revertTo` explicitly restores a version.
History, memory and epoch persistence are shared with TypeScript. Python constructor vocabulary is
generated from the same Action schemas and included in the revision prompt. Both languages use
the same inference model list and access policy (§2.5).

The rules require **every agent to be configured for strategy revision**. The LLM sits outside the
trading path: every `reviseEveryBlocks`, it looks at the strategy's own track record and its current
code and decides whether to rewrite it.

Generated code passes a **static check for cheatcodes (§1's glossary) → compilation** (evaluating the function expression
is capped at 1 second) before it is installed. **It is not trial-run first.** Once installed, every
call to `decide` is capped at **5 seconds** (`DECIDE_TIMEOUT_MS`, rules §2.3), the same bound a
hand-written strategy gets; exceeding it records that round as no action (`decide timeout:`). A revision that fails static checking or compilation is not installed; the failure is recorded and the
strategy keeps trading unchanged. There is no automatic rollback — reverting is the model's decision, made
with the version history and `revertTo`.

Configure it through the roster's `env`.

```yaml
agents:
  - id: my-strategy
    wallet: AUTO
    env:
      ERIS_LLM_MODEL: "claude-cli"       # only with --agent-sandbox process
      ERIS_IMPROVE_LOG_CALLS: "1"        # log the raw exchange to agents/<id>.llm.jsonl
```

**Backends supported today**:

| Value | What it runs | Auth |
|---|---|---|
| `codex` / `codex:<model>` | spawns `codex exec` | ChatGPT subscription (`codex login`) |
| `claude-cli` / `claude-cli:<model>` | spawns `claude -p` | Claude subscription |
| `claude…` (a model name starting with `claude`) | the Anthropic API | `ANTHROPIC_API_KEY` |
| `openai:<model>`, or a name starting with `gpt-` / `o1` / `o3` / `o4` | OpenAI-compatible chat completions | `OPENAI_API_KEY` (`OPENAI_BASE_URL` for a compatible endpoint) |
| anything else (default) | the ollama family | `ERIS_OLLAMA_BASE_URL` (Ollama Cloud by default) + `OLLAMA_API_KEY` |

> **In the competition no key reaches your agent.** Inference goes through the operator's proxy
> (rules §2.3, §2.5); the models you may use are the proxy's published list (§2.5) and every exchange
> is recorded. Set `ERIS_INFERENCE_BASE_URL` locally to exercise the same path
> (`infra/inference-proxy/README.md`).

**`claude-cli` / `codex` require process mode and an installed, authenticated CLI on the host.**
The official Docker image contains neither CLI. In Docker, use an API backend with the required
environment variables, or a reachable inference proxy (`ERIS_INFERENCE_BASE_URL`). The URL must
be reachable from the container; on macOS, address a host service through `host.docker.internal`.
Check revision success/failure and version history in `agents/<id>.jsonl`; completing a run does not
prove that self-improvement worked.

A run completes with no backend at all: the revision is recorded as failed and the strategy keeps
trading unchanged. Details in [llm-agents.md](guide/llm-agents.md).

---

## 6. The development loop: run, read, fix

After `git pull`, rerun `npm install`. For realtime, pass `--config config/local.yaml` with the
inline roster from §3. For backtest, `--agents` accepts a separate file with an `agents:` list
(`my-roster.yaml` below). Combining inline `agents:` with `--agents` is an error.

Official regimes use Docker. Start the Docker daemon and **build an image for every agent directory
in the roster before the first backtest**. A frozen twin sharing `dir:` uses the same image. For the
roster below:

```bash
for id in noop my-strategy multi-arb; do npm run agent:build -- team "$id"; done
```

Repeat after runtime updates (each build checks the base source and reuses unchanged layers).
If `backtest/state/manifest.json` is absent, finish §2's deploy and `npm run gen:state-dump` first.
For development without Docker, add `--agent-sandbox process` to backtest; this does not check the CPU or memory caps.

Once §2–§3 have run once, the daily routine is these three moves, repeated. **Keep one lap short**: a
360-block scenario takes 12 minutes.

```bash
# 1. Check the wiring on a short run (40 blocks ≈ 80 s; every submission, rejection and exception shows)
npm run sim:realtime -- --config config/local.yaml --blocks 40

# 2. Replay one scenario (--seed is required: a scenario is (regime, seed), a regime alone names none)
npm run backtest -- --regime crash --seed 101 --agents <your roster>

# 3. Run the whole public set and get a standing (60 scenarios × 12 min ≈ 12 hours; run it overnight)
npm run backtest -- --scenarios config/scenarios/public.yaml --agents <your roster>
```

**Always put opponents in the roster.** A deviation score is a position within a field, so with only
yourself T is undefined (an epoch with σ = 0 is dropped from the score). `config/rosters/full-field.yaml`
is the field of every reference agent, and `noop` in the roster lets you read the difference from doing
nothing.

```yaml
# my-roster.yaml
agents:
  - id: noop                 # the do-nothing baseline
    wallet: AUTO
  - id: my-strategy
    wallet: AUTO
  - id: my-strategy-frozen
    dir: my-strategy
    wallet: AUTO
    env: { ERIS_AGENT_FROZEN: "1" }
  - id: multi-arb            # a bundled opponent (§8)
    wallet: AUTO
```

Keep a **frozen twin** sharing the same code through `dir:` in the same field, and use its difference
as a control for execution-order noise, even for a rule strategy with no LLM. In #118's measurements,
identical code with zero installed revisions differed by ΔP≈26 USDC in calm#101 and ΔP≈2,873 USDC
(ΔT≈9.24) in whale#101. These are observations, not a guaranteed noise bound. Repeat across seeds
and assess improvements against the variation you measure.

The public set is **a handful of draws from a distribution, not the target**. The generator is open, so
**sample your own seeds**. Tuning to the published seeds falls apart the moment the non-public set hands
you a different draw. Judge by the **distribution across seeds**, not by one run (transaction order
varies even within a scenario).

**The reading order is fixed.** First `runs/<id>/agents/<id>.jsonl`, then `summary.json`, then the
dashboard (§7). Read backwards and all you learn is "the rank is bad".

### Reading `agents/<id>.jsonl`

One JSON per line, three kinds of line mixed together. The `kind: "mempool"` lines are what the
runtime recorded before a transaction landed in a block (the mempool stage).

| How to tell the line | Who writes it | What it means |
|---|---|---|
| `round` + `action` + `reason` (no `kind`) | your `ctx.log(...)`, or the runtime recording what `decide()` returned | The decision for that block. Put anything you like in `signals` / `state`. **A log without `reason` cannot be read afterwards** — write it from the start |
| `reason: "decide error: …"` | the runtime | `decide()` threw. No action that block. Guessing the shape of `obs` (§11) is the usual cause |
| `reason: "decide timeout: …"` | the runtime | Over 5 seconds (rules §2.3). No action. Counted separately from errors |
| `kind: "mempool"`, `event: "runtime_start"` | the runtime | Started, with `address` / `rpcUrl` / `mode`. **If this line is missing, the pre-flight failed** (can it reach the RPC, does the chain's identifying number — the chain id — match, are the venues' contracts in place) |
| `kind: "mempool"`, `event: "bad_action"` | the runtime | The returned action failed the schema. Nothing reaches the chain |
| `kind: "mempool"`, `event: "rejected"` | the runtime | It parsed but failed validation; `reason` says why (a leg with no inventory / priority fee over the cap / `tx gas cap` / `per-block gas budget`). Nothing reaches the chain |
| `kind: "mempool"`, `event: "submitted"` | the runtime | Signed and sent: `hash` / `nonce` / `priorityFeeWei` / `actionType` / `protocol` / `blockSeen`. **Whether it was mined is a separate question** — match `hash` against `blocks.csv` |
| `kind: "mempool"`, `event: "submit_failed"` | the runtime | The send itself failed (node refusal, nonce out of step); `error` carries the raw text |
| `reason: "revision installed"` / `"revision rejected"` / `"revision reverted"` / `"revision declined"` | the runtime (§5) | The outcome of an LLM revision; `state` holds the model's notes or the rejection reason. With `ERIS_IMPROVE_LOG_CALLS: "1"` the raw exchange is also in `<id>.llm.jsonl` |

Count first.

```bash
L=runs/<id>/agents/my-strategy.jsonl
grep -c '"event":"submitted"' $L        # how often you sent
grep -c '"event":"rejected"'  $L        # how often you were stopped before sending
grep -c 'decide error'        $L        # how often you threw
grep '"event":"rejected"' $L | jq -r .reason | sort | uniq -c   # why you were stopped
```

Zero `submitted` and a column of `rejected` is a **size or inventory** problem, not a strategy problem
(§11). `submitted` lines but `includedTxCount: 0` in `summary.json` means the priority fee was too low to
get into a block.

**`summary.json`** has one record per agent. Read `pnlUsdc` (P, the final minus initial boundary of `valueSeries.intervalSeries` — the value at each evaluation-interval boundary — each at its own marks).
`initialValueUsdc` / `finalValueUsdc` are both valued at the final marks; their difference is
`netPnlUsdc`, a different metric that can disagree with P in sign. Also read `includedTxCount` (mined transactions), `revertCount` (mined but reverted — gas paid for
nothing), `stderrTail` (the last output of a process that died), and the run-level `violations`.
**`blocks.csv`** is the full record of mined transactions (block, `txIndex`, sender, `priorityFeeWei`,
`status`); where in the block your transaction landed is read here.

`stress_schedule` in `events.jsonl` is the plan; `stress_event_applied` records actual application or submission. At run end, `stress_event_summary` / `stress_application_warning` (also `summary.json.stressEvents`) identify unobserved windows and price overlays that missed their peak. Match submitted hashes to `blocks.csv` to verify execution.

**Check your priority-fee bid in `blocks.csv`.** Find the submitted hash and compare its
`priorityFeeWei` and `txIndex` with other transactions in the same block.

When you fix something, change **one thing** and rerun the same seed. Change two at once and the
distribution cannot tell you which one worked.

---

## 7. Reading your results on the dashboard

```bash
npm run dashboard        # http://localhost:5173
```

Pick a competition from **Competition** in the left sidebar (one `--scenarios` run = one competition; a
single `sim:realtime` run appears as a one-scenario competition). EN / 日本語 switches the language. The
pages are three layers that follow the ladder **competition › scenario › interval**.

### Standings (`/`)

![standings](img/dashboard-standings.en.png)

This is the formula of rules §4.4 and nothing else. The columns:

- **score** — the weighted mean of the deviation score T, at two decimals, the precision rules §4.6 ranks
  on. The tooltip carries the number of scored epochs and the tie-breaks (std of T, worst epoch)
- **Δ** — the rank change since the previous completed epoch
- **form** — T per epoch as a small line (the dotted line is 50, the field's mean), with the count of
  scored epochs beside it. Whether an agent is "steadily above the field" or "one big epoch" is visible in
  the shape
- **regime columns** (CALM … DEPEG) — the agent's mean T within that regime. **An explanation, not a second
  ranking.** A row with one high column and the rest under 50 is a strategy that bet on that regime
- **details** — mined transactions and reverts (activity, not a ranking)
- **score by epoch**, above the table — every agent's cumulative score after each completed epoch. The
  last point of each line is the number in the table

The bar across the top is the **intervals** (the rules' evaluation intervals); **click one and the standings
rewind to that point** ("Standings · through interval k"). The rank at interval k is not a preview of the final
rank — the arbitrageurs may be leading only because the crash window has not opened yet.

The **scenario list** below the table is one row per world (`regime#seed`): intervals, leader, and the kinds
of environment event. "none scheduled" means no window event in that epoch, not that the regime is calm.
Click a row to open that world.

### The scenario page (`/scenario`)

![scenario](img/dashboard-scenario.en.png)

The board of one world. The bar at the top is that world's intervals; the **block axis** below it walks the
world block by block (play, single-step, speed). The board reads left to right: **wallets** (each agent's
account value), **the chain** (the transactions in that block and their priority fees), **contracts**
(each venue's state: pool price, GMX open interest, Aave utilisation, LST discount, eUSD price). Below:
the **standings within this world** (through interval k), the picked wallet's **agent log** (mined
transactions, method and venue), **venue price against fair** (the gap to fair is what arbitrage is made
of), and **account value at each scored boundary** (you against the field).

It never shows the future. No transaction or ranking past the block axis's head appears, so "what was
visible at this point" is reproduced as it was. The **Markets** tab is per-venue state (AMM / Perp /
Lending / Stablecoin / LST); **Explorer** lists blocks and transactions and deep-links into Blockscout
(`npm run explorer`) when it is running.

### An agent's page (`/agent/<id>`)

![agent](img/dashboard-agent.en.png)

Click a standings row to open it. The **Standing** tab answers "why this rank": rank, score, net PnL,
epochs scored; mean, std (tie-break 1) and worst epoch (tie-break 2) of T; the distribution of T; **by
epoch** (s / scenario / P / T / w); **by regime** (epochs / mean T / std of T).

`liquidator` in the picture is the textbook case. Only the five `lending-incident` epochs have T between
70 and 89; the other thirty sit between 45 and 53. Cumulatively it is 4th, but in every regime without a
liquidation it is below the field's mean. Why a strategy that wins big in one regime and loses in the rest
places below a steady one is visible in the per-regime rows.

The rank badge at the top right is **the rank within the world (scenario) currently open**; the
competition rank is the "k of n" in the Standing tab. The other tabs: **Overview** (the account value
curve and end-of-run positions), **Intervals** (this agent's Δ value / log return / rank per interval),
**Positions** (every venue: GMX perps, Aave accounts with HF, LST queues, Trove ICR), **Trade history**,
**Decision log** (the contents of `agents/<id>.jsonl`).

### What is visible in the competition and the trial environment

The operator-hosted dashboard is public, but whatever would break a competition in progress is dropped on
the server. `ERIS_DASHBOARD_AUDIENCE=1 npm run dashboard` shows you the same view locally.

| | Local (`npm run dashboard`) | Trial environment (9/23 – 10/31) | Live week (11/1 – 11/7) | After the results |
|---|---|---|---|---|
| Standings | shown | **not shown** (rules §4.7) | shown, updated per epoch | shown |
| A scenario's regime and seed | shown | — (a continuous chain, no regimes) | **not shown** (only `epoch s`) | shown |
| Environment event schedule | shown | closed windows only | not shown | shown |
| Decision logs, LLM exchanges | shown | not shown (they are on your machine) | not shown | shown (rules §7.2) |
| Venue state, transactions, explorer | shown | shown | shown | shown |

---

## 8. The reference agents

From `example/agents/`, the ones **worth copying from** (benchmarks and internal measurement agents left
out). Any of them goes straight into a roster as an opponent. A "yes" in the `prompt.md` column means the
directory is in submittable form (`kind: improve`) and is a worked example of a revision policy. "Where
it works" is the regime whose environment gives the strategy something to do (§1), not a measured PnL.

| Group | Agent | What it does | Main venue | Where it works | prompt.md |
|---|---|---|---|---|---|
| Starting point | `my-arb` | The template you copy. A naive arbitrage that swaps toward fair on the venue furthest from it. Sizing, fees and two-leg execution are deliberately left out | Uniswap / Balancer / Curve | all | yes |
| Python starting point | `my-arb-py` | The same decisions as `my-arb`, using the generated Python SDK and a revision policy | Uniswap / Balancer / Curve | all | yes |
| Benchmark | `noop` | Does nothing. In a roster it shows the difference from not moving (the competition's benchmark is this) | — | — | no |
| Arbitrage | `venue-arb` | Cross-venue WETH arbitrage; takes only gaps above fee + safety margin | the 3 AMMs | calm / whale / cex-drift | yes |
| Arbitrage | `multi-arb` | Cross-venue arbitrage on WETH or WBTC alike. Chooses between buying and selling on two exchanges at once (two-leg) and trading only the one venue that strays from the reference price (single-leg) | the 3 AMMs | same | yes |
| Arbitrage | `stat-arb` | Tracks each asset's gap from the reference price, measures how unusual the current gap is against that history (a z-score) and bets on it closing | AMMs | calm / informed-flow | no |
| Arbitrage | `max-profit-arb` | Derives a priority-fee ceiling from the expected profit and bids for position in the block | AMMs | whale | no |
| Arbitrage | `flash-arb` | An Aave flash loan for arbitrage beyond its own capital, in one transaction (`rawTx`). The receiver contract is deployed only under the example config (`run.flashArb: true`), so in the official regimes it reverts as it stands | Aave + AMMs | whale / crash (after pointing it at a receiver you deploy) | no |
| Arbitrage | `basis-arb` | One AMM leg hedged on the GMX perp (spot against futures) | AMMs + GMX | cex-drift | yes |
| LP | `lp-provider` | Holds a Uniswap V3 position for fees, pulls it when the gap gets large | Uniswap | calm | no |
| Leverage | `levered-long` | Borrows on Aave against its own holdings to hold more WETH than it was given (leverage); keeps HF inside a chosen range and repays when it drops below | Aave | cex-drift (direction) / lending-incident, crash (defence) | no |
| Leverage | `lst-carry` | Stakes the LST for yield or trades the redemption-rate / market-price gap. The Aave collateral loop is opt-in via `ERIS_LST_LEVERAGE_TARGET_HF` | LST + Aave | calm | yes |
| Liquidation | `liquidator` | Aave `liquidationCall`; idle until victims appear. The example of the **`run(ctx)` form** (§3, not submittable) | Aave | lending-incident | no |
| CDP | `redemption-arb` | Buys eUSD at a discount and redeems it against the riskiest Trove | Liquity + the eUSD pool | when eUSD trades below par; the dedicated verification regime is `config/regimes/liquity.yaml` | yes |
| CDP | `trove-manager` | A borrower that opens a Trove and holds it through the price path, defending against liquidation, redemption and Recovery Mode | Liquity | crash / lending-incident | yes |
| CDP | `sp-underwriter` | Deposits eUSD in the Stability Pool to absorb liquidations and calls `liquityLiquidate` itself | Liquity | crash / lending-incident | yes |
| Stablecoin | `peg-arb` | Buys a market-priced stable (DAI) below a dollar and sells when it returns | Curve | depeg | yes |
| Regime 7 | `discovery-arb-verify` | Dry-runs a pool that appeared mid-epoch before taking it | new pools | vuln | no |
| Regime 11 | `launch-confirm` | Enters a listed token's pool after consecutive blocks of net buying, exits on the first block of net selling | new listings | launch | yes |
| Regime 11 | `launch-sniper` | Buys a listing at first sight and sells after a fixed hold (the no-judgment control) | new listings | launch | yes |
| Regime 7 | `discovery-arb` | Takes the same pools without checking (the control; the one that gets skimmed) | new pools | vuln | no |
| Attack / defence | `vault-keeper` | The honest but buggy creator: deploys a `LeakyVault` whose `rescue()` was left ungated and puts USDC in it | own contracts | all | no |
| Attack / defence | `exploit-hunter` | Recovers selectors from the bytecode of someone else's unknown contract and drains it atomically through an `Exploiter` | own contracts | all | no |
| Verification only | `market-launcher` / `market-taker` / `trap-launcher` | Create, use and trap a permissionless lending market. Not in the official regimes; only `config/regimes/agent-markets.yaml` | lending | outside the official set | no |

---

## 9. The practice devnet (optional)

A chain that does not stop, which you can point your own agent at from your own machine. **It is not
official scoring** — nothing from the practice period counts toward the standings.

You need the `manifest.json` the operator publishes (RPC, chain id, every venue address, evaluation-interval
length, action vocabulary, fee defaults, and an explicit statement that **there is no order-size
cap**) and your own wallet. Your decision log stays **on your machine and
nowhere else**. Steps are in [practice-devnet.md](guide/practice-devnet.md).

Practice teaches you execution and how to read observations. **Epoch resets and deviation scoring do not
exist there** — that structure only exists in the real thing.

---

## 10. Submitting

Run all of these before you send anything.

```bash
npm install                    # refresh dependencies after git pull too
npm run typecheck
npm run check:strategy          # cheatcode static check (the entry gate)
npm run backtest -- --scenarios config/scenarios/public.yaml --agents <your roster>
npm run bundle:agent my-strategy
```

That writes `bundle-my-strategy.zip` (the runtime, the sdk, the shared lib, and your agent
directory). `bundle:agent` **refuses** a directory without a `prompt.md` (frontmatter `kind: improve` /
`name` / `description`): rules §2.5 require every submitted agent to revise its strategy, so a
rule-only `decide()` runs but is not a submission.

**You can check your resource budget yourself.** In the competition each agent runs in a container
capped at rules §2.3's limits (2 vCPU / 4 GB). The **same image and the same caps** are available
locally.

```bash
npm run agent:build -- team my-strategy     # build the submission image
npm run agent:selftest -- my-strategy       # short run under the same caps; reports whether you fit
```

`agent:selftest` prints `PASS` / `FAIL` and the exact `summary.json` path. Early exits, missing results and surviving containers also return a nonzero exit code. `PASS` means completion under the cap for that run, not a peak-memory measurement or a guarantee for every scenario.

The competition, and `npm run backtest` on the official regimes, launch agents through this container
(`run.agentSandbox: docker`). Without docker, `--agent-sandbox process` runs them as plain processes — with
no caps.

An agent over the cap is **OOM-killed** (`--memory-swap` is pinned to `--memory`, so there is no
swapping out of it) and reaches the coordinator as an early exit with code 137. **That is
indistinguishable from a record of choosing not to trade**, so check before you submit. Details in
[infra/docker-agent/README.md](../infra/docker-agent/README.md).

During the submission period you may **replace your submission up to 5 times a day** and **nominate
up to 2 submissions** for final evaluation. With two, each is evaluated independently against the
non-public set and **the higher score** becomes your final score. When the submission period closes
your agent is frozen, and only the in-epoch LLM revision keeps running.

---

## 11. Ways people actually break this

**Sending the leg you have no inventory for.** Selling while you hold only USDC is rejected by the
runtime's validation and leaves a `rejected` entry. Nothing reaches the chain, so the result is
**identical to an agent that chose not to trade**. Four bundled agents once shipped with this bug.
Use `canFund` / `affordable` from `example/agents/lib/affordable.ts`, and size with `sized` as a
fraction of your own balance (the environment no longer hands out a size cap, so there is nothing
to read out of `obs.limits`).

**`prompt.md` without `kind: improve`.** Startup fails, and the error message says so.

**Guessing the shape of `obs`.** Reading `obs.pool` directly gives `undefined` and a `TypeError`, and
the round is skipped. A log full of `decide error:` is this. It is `obs.protocols.uniswap.pool`.

**Not noticing you never reached the chain.** The runtime checks RPC connectivity, the chain id and
the venues' bytecode at startup and **exits 1** if any of it is wrong. An agent that stays alive
without reaching the chain leaves only `includedTxCount: 0`, which is indistinguishable from a record
of choosing to do nothing.

**Treating a mid-epoch unrealised gain as a result.** Only the **value at the end of the epoch** is
scored. A position you cannot close is valued as a position you cannot close.

---

## 12. What to read next

| Document | Contents |
|---|---|
| [ascon.dev/rules](https://ascon.dev/rules) | **the rules themselves** (the only source) |
| [writing-agents.md](guide/writing-agents.md) | strategy authoring in depth; every field of `obs` |
| [protocols-and-actions.md](guide/protocols-and-actions.md) | the action catalogue per venue |
| [llm-agents.md](guide/llm-agents.md) | how self-improvement works and how to configure a backend |
| [backtest.md](guide/backtest.md) | scenario replay and the scenario matrix |
| [stress-events.md](guide/stress-events.md) | the market stress events and their calibration |
| [dashboard.md](guide/dashboard.md) | the visualisation |
| [docs/spec/](spec/en/README.md) | the normative as-built reference |
