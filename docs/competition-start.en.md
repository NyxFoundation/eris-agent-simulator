[← README](../README.md) ｜ 日本語: [`competition-start.md`](competition-start.md)

# Getting Started (competition entrants)

**A straight line from nothing to a submittable agent.** About 30 minutes to something running.

The rules themselves live at [ascon.dev/rules](https://ascon.dev/rules) and are the only source for
them; the Japanese text governs. Where this guide and the rules disagree, the rules win. This guide
only covers how to build. The [Japanese version](competition-start.md) governs this guide too; this
one is a reference translation.

**You need**: Node.js 20 or newer, [Foundry](https://book.getfoundry.sh/getting-started/installation)
(`forge` and `anvil`), `git`, and `zip` (used to build the submission archive).

---

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
                                progress. NOT used for scoring.
```

**Scoring takes exactly one number per epoch.**

```
PnL P    = asset value at the epoch's end − asset value at its start (in USDC)
score T  = 50 + 10 × (P − mean over all units) / standard deviation
final    = weighted mean, later epochs heavier (1.0 at the first, 1.5 at the last)
```

So the competition is **"how did you do against everyone else that round", stacked k times**. An
unrealised gain in the middle of an epoch is worth nothing; only the value at the end counts. A
market-wide move is absorbed into everyone's mean, so **you neither gain from a rally nor lose from
a selloff.**

Every unit is handed the same initial capital: **8 WETH + 0.4 WBTC + 25,000 USDC**, plus ETH for
gas. One benchmark agent that never moves its capital runs alongside. Every unit runs on the same single chain at the same time.

> **All of that is the competition's scoring, not this repository's.** `npm run backtest` and
> `summary.json` still score the old way: `mean − 0.25 × std` of the excess log return over 12-block
> intervals, then a z-score within the scenario and an equal-weight mean over regimes. Weighting later epochs is **not implemented**
> locally. **Local numbers are for comparing your own versions against each other, not for predicting
> where you will place.**

### Vocabulary (read this)

**The rules and the code use the same words for different things.** This is the one table to
remember.

| The rules say | The code calls it | What it actually is |
|---|---|---|
| epoch | run | one `runs/<id>/` — one `summary.json` |
| scenario | scenario | `<regime>#<seed>`; regimes are defined in `config/regimes/*.yaml` |
| evaluation interval | **epoch** / "round" in the dashboard | `epochScores` in `summary.json`, `run.epochBlocks: 12` |

**The code's `epoch` is not the rules' epoch.** The code's `epoch` is the rules' *evaluation
interval*.

---

## 2. Setup

```bash
git clone <repo> && cd eris-competition-poc
npm install
cp config/example.yaml config/local.yaml   # run config + roster
cp .env.example .env.local                 # keys and RPC (Anvil's dev keys are fine locally)
npm run build:contracts                    # forge build PriceFeed + mock oracles (once)
```

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
npm run sim:realtime
```

A `runs/<id>/` directory appears; if `summary.json` holds a result per agent, you are set up.

> **Redeploying means rebuilding the anvil too.** `--keep-fresh` only removes `deployments.json`;
> running it twice against the same anvil fails at the WETH wrap with `insufficient funds`.

---

## 3. The smallest submittable agent

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

Now `npm run sim:realtime` spawns your agent. To use an id that differs from the directory name, name
the directory with `dir:` — that is how you run one strategy several times with different parameters.

### `agent.ts` — the strategy

```ts
import type { AgentAction, AgentObservation } from "@eris/sdk";

export function decide(obs: AgentObservation): AgentAction | null {
  return { type: "noop", reason: "not doing anything yet" };
}
```

That is the whole contract.

- If you return an action, the runtime **validates it before** signing and sending. **Neither kind of
  failure reaches the chain** (fail-closed). Something malformed enough to fail the schema is logged
  as `bad_action` in `agents/<id>.jsonl`; something that parses but does not validate is `rejected`
- Returning `null` skips the round. **Doing nothing is a perfectly good answer** — not trading in a
  market with no opportunity is correct
- Throwing does not break the run: that round is skipped and `decide error:` is logged

> **Write a submission as `decide()`.** The runtime also accepts `run(ctx)` in place of `decide`, for
> an agent that owns its own loop (see `liquidator`) — but **`run(ctx)` and `prompt.md` cannot
> coexist**: self-improvement works by swapping out `decide`, so an agent with both exits 1 at
> startup (`example/agents/runtime/bot.ts:287`). Since rules §2.5 makes `prompt.md` mandatory, the
> `run(ctx)` form cannot currently be submitted.

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
yourself.

```ts
obs.fairPriceUsdcPerWeth        // the reference price the environment publishes (on-chain PriceFeed)
obs.protocols.uniswap.pool      // per-venue state
obs.balances                    // your balances; stables come itemised
obs.limits                      // per-round caps, open-position cap
```

**What the observation does not carry**: unconfirmed orders, the next block, where the event windows
are. Everyone sees the same things with the same delay (writes to `PriceFeed` land in the next block,
so the reference price is always one block behind).

Two qualifications. **The highest priority fee anyone else paid in the most recent block is in the
observation** (`obs.competition.maxCompetitorPriorityFeeWei`) — that is the history of a mined block,
not anyone's pending order. And `decide(obs, ctx)` hands you `ctx.publicClient` / `ctx.walletClient`,
so **querying the node directly is not itself forbidden**. What is allowed is set by rules §8 (prohibited conduct).

**There are two kinds of limit and they bite differently.**

| Where it comes from | What it caps | What happens if you exceed it |
|---|---|---|
| `obs.limits` (the runtime validates it) | per-round trade size (`maxWethInWei` / `maxUsdcInUnits` / a cap per base), actions in a bundle (`maxBundleActions`), open positions (`maxOpenPositions`), priority fee | **rejected** before signing, with a `rejected` entry in `agents/<id>.jsonl`. Nothing reaches the chain |
| rules §2.3 and §2.6 (the operator imposes it) | **3 transactions per block** (bundles included, §2.6), **5,000 ms** per decision, **2 vCPU / 4 GB** of memory (§2.3) | as the rules provide. **These are not in `obs.limits`** |

Reading `obs.limits` keeps you inside the first set automatically. **The second set is yours to
respect.**

The action catalogue is in [protocols-and-actions.md](guide/protocols-and-actions.md); every field of
`obs` is in [writing-agents.md](guide/writing-agents.md).

---

## 5. LLM strategy revision

The rules require **every agent to be configured for strategy revision**. The LLM sits outside the
trading path: every `reviseEveryBlocks`, it looks at the strategy's own track record and its current
code and decides whether to rewrite it.

Generated code passes a **cheatcode static check → compilation** (evaluating the function expression
is capped at 1 second) before it is installed. **It is not trial-run first.** Once installed, every
call to `decide` is capped at **5 seconds** (`DECIDE_TIMEOUT_MS`, rules §2.3), the same bound a
hand-written strategy gets; exceeding it records that round as no action (`decide timeout:`). A revision that fails is not installed; the failure is recorded and the
strategy keeps trading unchanged. There is no automatic rollback — reverting is the model's decision, made
with the version history and `revertTo`.

Configure it through the roster's `env`.

```yaml
agents:
  - id: my-strategy
    wallet: AUTO
    env:
      ERIS_LLM_MODEL: "claude-cli"       # a subscription CLI works for local development
      ERIS_IMPROVE_LOG_CALLS: "1"        # log the raw exchange to agents/<id>.llm.jsonl
```

**Backends supported today**:

| Value | What it runs | Auth |
|---|---|---|
| `codex` / `codex:<model>` | spawns `codex exec` | ChatGPT subscription (`codex login`) |
| `claude-cli` / `claude-cli:<model>` | spawns `claude -p` | Claude subscription |
| `claude…` (a model name starting with `claude`) | the Anthropic API | `ANTHROPIC_API_KEY` |
| anything else (default) | the ollama family | `ERIS_OLLAMA_BASE_URL` (Ollama Cloud by default) + `OLLAMA_API_KEY` |

> **OpenAI API keys and OpenAI-compatible endpoints are not supported yet** (OpenAI is reachable only
> through the `codex` subscription CLI). Which inference services you may use on submission is set by
> rules §2.5.

A run completes with no backend at all: the revision is recorded as failed and the strategy keeps
trading unchanged. Details in [llm-agents.md](guide/llm-agents.md).

---

## 6. Checking your own work

**Replay one scenario.** `--seed` is required: a scenario is (regime, seed), so a regime alone does
not name one.

```bash
npm run backtest -- --regime crash --seed 101 --agents config/rosters/full-field.yaml
```

**Run the whole public set and get a standing.**

```bash
npm run backtest -- --scenarios config/scenarios/public.yaml --agents <your roster>
```

The public set is **a handful of draws from a distribution, not the target**. The generator is open,
so **sample your own seeds**. Tuning to the published seeds falls apart the moment the non-public set
hands you a different draw.

What to read:

| Where | What it tells you |
|---|---|
| `runs/<id>/agents/<id>.jsonl` | every round's reasoning, submissions and rejections. **Start here** |
| `runs/<id>/summary.json` | PnL, violations, per-agent results |
| `npm run dashboard` | standings, per-round movement, venue state, replay |

---

## 7. The practice devnet (optional)

A chain that does not stop, which you can point your own agent at from your own machine. **It is not
official scoring** — nothing from the practice period counts toward the standings.

You need the `manifest.json` the operator publishes (RPC, chain id, every venue address, round
length, action vocabulary, limits) and your own wallet. Your decision log stays **on your machine and
nowhere else**. Steps are in [practice-devnet.md](guide/practice-devnet.md).

Practice teaches you execution and how to read observations. **Epoch resets and deviation scoring do not
exist there** — that structure only exists in the real thing.

---

## 8. Submitting

Run all of these before you send anything.

```bash
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

An agent over the cap is **OOM-killed** (`--memory-swap` is pinned to `--memory`, so there is no
swapping out of it) and reaches the coordinator as an early exit with code 137. **That is
indistinguishable from a record of choosing not to trade**, so check before you submit. Details in
[infra/docker-agent/README.md](../infra/docker-agent/README.md).

During the submission period you may **replace your submission up to 5 times a day** and **nominate
up to 2 submissions** for final evaluation. With two, each is evaluated independently against the
non-public set and **the higher score** becomes your final score. When the submission period closes
your agent is frozen, and only the in-epoch LLM revision keeps running.

---

## 9. Ways people actually break this

**Sending the leg you have no inventory for.** Selling while you hold only USDC is rejected by the
runtime's validation and leaves a `rejected` entry. Nothing reaches the chain, so the result is
**identical to an agent that chose not to trade**. Four bundled agents once shipped with this bug.
Use `canFund` / `affordable` from `example/agents/lib/affordable.ts`.

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

## 10. What to read next

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
