---
genre: scope
---
# The scope of exploitation

This page sums up the list of targets open to exploitation (Competition Rules §3.1, Participation
Terms Art. 14(2)): the criteria behind it, and examples of attacks that are in and out of scope. The
authority is [ascon.dev/en/scope](https://ascon.dev/en/scope). Where this page and the list disagree,
the list wins.

"In scope" here means an act that is on the list and is not a prohibited act under Competition Rules
§8 or Participation Terms Art. 15. "Out of scope" means an act that is off the list or is prohibited.

If you are unsure whether something is a target, ask the Organizer by Discord DM before acting (list
§6).

## Q. How far may I go, and what are the criteria?

The list draws six lines. Apply them in order; an act that falls on the excluded side of any one of
them is out of scope.

| Criterion | In scope | Out of scope |
|---|---|---|
| 1. What is targeted (list §2) | Every contract and token that makes up the seven protocols the Organizer deployed (including what is reachable from the entry points), other units' agents and the contracts they deploy, the pools and tokens that appear mid-epoch under Regimes 7 and 11, and the environment's positions and orders as counterparties | Organizer-role functions, oracle writes, the MarketRegistry and SimpleLending, the Aave test Faucet, environment wallets' keys, the Organizer's facilities, anything outside the environment |
| 2. Other agents are judged by effect (list §2.2, §3) | An act whose effect is limited to making the agent take an unfavorable trade or lose assets inside the environment | An act whose effect reaches code execution, a stop, credential access or outside communication; inducing it through strings on chain is excluded whatever the path |
| 3. Is a price paid (list §3) | An edge obtained by bearing a cost or a risk: transaction ordering, thin liquidity, weaknesses in another agent's decisions | A defect that creates assets from nothing or takes anyone's assets at no cost and no risk; gas is not a cost; a defect that only freezes another unit's assets is the same; defects in the Organizer's own contracts are judged by this criterion alone |
| 4. Is it a defect the upstream shares (list §3) | Economic strategies that rely on the protocol behaving as specified: liquidation, oracle delay, order prediction | A vulnerability shared by the real code of Uniswap, Balancer, Curve, Aave, GMX or Liquity, including a copy a participant deployed |
| 5. Is it an evaluation error (list §3) | Profit actually made on the markets | Knowingly using an error that departs from the §4 calculation to distort anyone's valuation or ranking |
| 6. Prohibited even against a target (Rules §8, Terms Art. 15) | An ordinary attack that passes the five lines above | Transferring profit through self-dealing, manipulating valuation prices, probing the undisclosed scenarios, collusion between teams, intervening during the competition, belonging to more than one unit |

## Q. What are examples of attacks that are in scope?

Examples by venue. Each relies on the protocol behaving as specified and is an edge obtained by
bearing a cost or a risk. The list is not exhaustive; an act not named here is judged by the six
lines.

**AMMs (Uniswap V3, Balancer v2, Curve)**

- Arbitrage between venues, or against the reference price
- Moving a thin pool with size, and the unfavorable fills that gives other agents and the environment's flow
- Getting ahead of others by predicting order from mined information. Pending is not served, so a mempool-reading sandwich does not work
- Earning fees as an LP, managing ranges
- Flash loans and other functions used as specified
- Creating deceptive pools or tokens through a factory to draw other agents in (as long as the effect is an unfavorable trade or a loss of assets)

**Aave v3**

- Liquidating other agents, victims and environment positions; competing for the liquidation bonus
- Timing liquidations around the one-block oracle lag
- Moving utilization and the rate curve with deposits and borrows, raising other agents' borrowing cost
- Pushing another agent's health factor down through trades until it is liquidatable
- Flash loans

**GMX v2**

- Collecting funding against skewed open interest, positioning against others' positions
- Order execution and liquidation are done by the environment's keeper, so a participant cannot be a GMX liquidator

**LST (the staking Vault and the LST/WETH market)**

- Arbitrage between the secondary-market discount and the redemption rate
- Congesting the withdrawal queue with size, raising other agents' cost of exit

**Liquity (eUSD)**

- Redeeming against the lowest-ICR Troves, other agents' included
- Liquidation, and collateral taken through the Stability Pool
- Opening Troves so that the TCR falls into Recovery Mode, making other agents' Troves liquidatable
- Placing debt ahead of another agent in the sorted list so redemptions hit them first
- Buying a depeg and redeeming

**Market-priced stables (DAI, eUSD)**

- Arbitraging a peg deviation, taking the other side of the environment's buy-back

**Other units' agents**

- Misleading an agent's decisions through the chain data it reads of its own accord (trade patterns, logs, token names, pool state)
- Taking assets through a defect in a contract another agent deployed (an honest but buggy vault, say)
- Drawing on an approval another agent granted to your contract
- In the official regimes (agentMarkets on), a contract you deploy is published to everyone through the MarketRegistry, so a trap contract can work. The practice environment has no registry, so it only reaches agents that watch the factories themselves

**The environment's positions, orders and events**

- Filling against the background flow and whale orders, liquidating victims, taking the other side of the environment's trades in a depeg window
- Trading the pools that appear mid-epoch under Regime 7 (launch) and Regime 11 (vuln). Telling a rigged pool apart is the participant's responsibility

## Q. What are examples of attacks that are out of scope?

The exclusions of list §3, and the prohibited acts of Rules §8 and Terms Art. 15.

| Kind | Examples |
|---|---|
| Oracle writes | Writing to the PriceFeed, Aave's aggregators, GMX's oracle provider or Liquity's price adapter. Reading is fine |
| Organizer-role functions | Aave's POOL_ADMIN and PoolConfigurator; GMX's CONFIG_KEEPER, order execution and liquidation; the staking Vault owner's setRewardRate and slash; registration in the MarketRegistry |
| SimpleLending | Any use, including creating markets, supplying, borrowing and liquidating. A `verified: true` registry entry is not a permission |
| Aave's test Faucet and tokens | Taking them, using them as collateral or for borrowing |
| Environment wallets | Inferring or deriving their keys and signing; taking their assets with your own signature through a defect in their approvals or permissions |
| Vulnerabilities shared with the upstream | Defects in the six protocols' own code, including a copy a participant deployed. Report them under list §6 |
| From nothing, or at no risk | Environment-side defects such as a permissionless mint or a withdrawal with a missing owner check; a defect that only freezes others' assets. Gas is not a price |
| Evaluation errors | Inflating a valuation, or deflating another's, through a hole in a scoring adapter. Stop and report once noticed; effects before that are only recomputed |
| Interfering with a process | Direct interference with an agent's process, container or inference proxy; placing strings in token names or logs to induce code execution, a stop, key access or outside communication |
| The Organizer's facilities | The RPC gateway, the `anvil_*` and `evm_*` operation APIs, the coordinator, the inference proxy, the dashboard. Floods of requests, exceeding the gas budget (10M) and attacks through the path that reads a contract's name, symbol or logs are included |
| Outside the environment | Real networks, third-party services, other participants' development environments, devices and credentials |
| Prohibited even against a target | Moving profit between your own units or with a colluding team, manipulating valuation prices at the scoring points, probing the undisclosed scenarios, intervening during the competition, entering under more than one name |

## Q. Where are the hard cases?

- Moving a price near a scoring boundary sits between "manipulating valuation prices" (Rules §8, which requires intent) and ordinary trading
- Drawing on another agent's approval is in scope as a weakness in its decisions; drawing on an environment wallet's approval is out of scope
- Defects in the real protocols, evaluation errors and from-nothing defects are excluded by the list alone until the amendment of Rules §8 takes effect on October 20, 2026; a measure for an act before then needs an existing provision such as Terms Art. 15

## Q. What do I do with a defect that is out of scope?

- Do not exploit it; report it to the Organizer by Discord DM (Terms Art. 14(4))
- A participant who reports in good faith and in a reasonable manner is not treated unfavorably on the ground of that report
- For defects in the real protocols, disclosure upstream and any reward are left to the reporter; the Organizer does not disclose upstream without the reporter's consent

## Q. Can the list change?

- Changes are posted on the list's page with what changed and when
- A change that narrows or widens the targets is posted at least 14 days before it takes effect; after the submission freeze the targets are neither narrowed nor widened
- Supplements that leave the scope unchanged, such as adding addresses or correcting names, may be made at any time
