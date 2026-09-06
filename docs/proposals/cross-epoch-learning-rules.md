[← README](../../README.md)

# Cross-epoch learning: the rules amendment (issue #77)

The runtime and infrastructure halves of issue #77 live in this repository. The third half does
not: §4.7.1 of the competition rules says every participating unit starts each epoch from identical
initial conditions, and says nothing about the agent's own state, so carrying a revised strategy
between epochs is currently neither permitted nor forbidden — it is unspecified, which is the worst
of the three.

The rules live in **ascon-web, `content/legal/rules.md`**, which is a different repository. This
file is the wording proposed for it, kept here so the code and the clause it depends on are written
together and reviewed together. It is a proposal, not the rule: nothing here is in force until it
lands in ascon-web.

**Timing.** The rules revision takes effect **2026-09-22** and the submission period opens
**2026-09-23**. The wording has to be settled before the 22nd or shipped as a further revision
afterwards. Recommended: before, because a participant deciding whether to build a learning agent
needs to know in the week they are building it, not in the week after.

## What is being permitted

An agent's internal state — including the strategies its own LLM revised under §2.5 — is carried
from one live epoch to the next. The organizer provides each participating unit a persistent area
that only that unit's agent can see.

What is **not** carried is unchanged: assets, positions, chain state, funding and the scenario are
reset for everybody at every epoch. The environment is identical; the agent is not.

## Proposed changes

### §4.7.1 — 初期条件

Today the clause reads that every participating unit starts from identical initial conditions and
that the previous epoch's assets and positions are not carried over. Assets and positions are the
only things it names, and "同一の初期条件" reads as if it covered the agent too.

> **各エポックは、全参加単位に対して同一の *環境* 初期条件から開始します。** チェーン状態、資金、
> シナリオは毎エポック全参加単位に対してリセットされ、前のエポックの資産・ポジションは引き継ぎ
> ません。
>
> **エージェント自身の内部状態は引き継がれます。** これには §2.5 に基づいて改訂された戦略が含ま
> れます。運営は参加単位ごとに、その参加単位のエージェントのみが参照できる永続領域（容量は付録 A）
> を提供し、これは競技期間の開始時に空で作成され、全エポックを通じて保持されます。この領域に何を
> 書くかは参加者の裁量です。

### §2.5 — 自己改善

> 「それまでの取引の記録および損益」は、**エポックをまたいで**参照できます。損益はエポック単位で
> 集計されますが、モデルに渡される戦略の版歴は、それが導入されたエポックの識別子とともに、競技
> 期間全体にわたります。

### The 💡 note on freezing

The note today says the agent is frozen at the 10/31 submission deadline, which reads as "the
running strategy does not change".

> **提出物**は 10/31 の締切で凍結されます。凍結されるのは提出されたコードであって、実行中の戦略
> ではありません。§2.5 に基づく自己改善は、エポック内でもエポックをまたいでも動作します。

### §4.4.2 — 無効化されたエポックの再実行

> 再実行は、無効化されたエポックの**開始時点で取得されたエージェント状態のスナップショット**から
> 開始します。同じシードで再実行しても、エージェントが 1 回目の試行の終了状態から始めるのであれば
> それは再実行ではなく別の実験です。

Implemented: `core/src/realtime/agentState.ts` snapshots each agent's directory before the epoch's
processes start, and the restore is an operator command, because voiding an epoch is a judgment
(§4.4.2) and a harness that restored on its own would be making it:

```bash
npm run agent-state -- list    --root runs/state
npm run agent-state -- restore --root runs/state --run <the voided epoch's run id>
```

It refuses loudly when an agent in that epoch has no snapshot, rather than putting some agents back
and letting the others re-run with the state of the attempt being thrown away. The most recent
snapshots are kept (`ERIS_AGENT_STATE_SNAPSHOTS`, default 8); older ones are pruned, because one
copy of a 64 MiB directory per agent per epoch is tens of gigabytes over a k = 40 competition and
§4.4.2 voids an epoch and re-runs it promptly or not at all.

### Appendix A — 定数

| 項目 | 値 |
|---|---|
| エージェント永続領域の容量 | 64 MiB（参加単位あたり、任意時点でのディレクトリ容量） |

Not a per-epoch allowance: that would let a patient agent accumulate without limit. What is measured
is **the size of the directory at any moment**, so an agent that writes and deletes repeatedly is
within the rule — it is holding 64 MiB, which is what the organizer has to provision.

**Where the cap is enforced, and where it is not.** The reference runtime refuses its own writes
past the cap and says so in the agent log (`example/agents/runtime/state.ts`). A participant's own
runtime writing its own files is *not* stopped by that code — it is their directory. Enforcing it
against them is the operator's job, at the volume: a quota, or a size-limited mount. Without one the
number in this table is a rule with no mechanism behind it, and one participant filling the host
disk is everybody's failed epoch.

## §7 — the schedule-inference exposure, decided

k = 40 epochs over 8 regimes at equal count (§3.3) means five of each. An agent that remembers which
regimes it has already seen knows, late in the competition, which regimes remain — not their order.
That is ordinary learning under this proposal, and it also sits close to the letter of the
prohibited act 「発生スケジュールを特定しようとする行為」.

**Decision: (a) narrow the prohibition.** The prohibited act is aimed at the hidden set and the
lottery seed themselves — probing the organizer, recovering the seed, attacking the commitment —
and inference from epochs that have already happened is permitted.

> **§7** 「非公開シナリオの探索」とは、非公開セット、抽選シード、またはコミットメントに対して、
> 運営への働きかけ・技術的な推測・その他の手段でこれらを直接特定しようとする行為を指します。
> **既に実現したエポックから得られた情報に基づく推論は、これに該当しません。**

Why not (b), i.i.d. regime draws that make counting useless: it costs the regime balance §3.3
promises, and it interacts with the 💡 that justifies the lottery by the weight schedule. And the
information (a) permits is weak — which regimes are left, never which epoch — while the rising
weight `w_s` (1 → 1.5) already says late epochs are where learning is supposed to pay.

## The other four decisions

| # | question | decision |
|---|---|---|
| 2 | what may persist | Anything the participant's runtime writes, within the cap. The reference runtime writes `versions.json`; the layout is documented, not mandated. The `memory` field in the revision reply is **in** — a conclusion that has to be re-derived from the source every epoch mostly is not re-derived, and it costs one string (capped at 4,000 characters, bounded where it is set rather than where it is written, so it cannot inflate the model's own next context) |
| 3 | the size cap | 64 MiB, measured as the directory's size at any moment. Enforced by the reference runtime on its own writes and by the operator on the volume for everything else |
| 4 | §4.4.2 re-runs | Yes, restore the epoch-start snapshot |
| 5 | timing | Amend before 2026-09-22, with the current revision |

## Two places the implementation is narrower than the rule

- **Segmented periods see more than one epoch's logs.** The agent container's log mount was the
  whole of `runs/` and is now the run the agent is in. On the practice devnet (ADR 0021 §6) the run
  directory rolls under a live agent and the pointer naming the current segment sits one level up,
  so the mount there is the competition directory — every segment of that period, not just the
  current one. The live competition is one coordinator per epoch and does not take that path. The
  practice devnet is self-hosted by the participant, where the isolation is not the point.
- **Validate against the plan, not the cross-product.** `backtest --scenarios` takes either form,
  and `--agent-state-root` carries state in the order the file lists. Given a `{regimes, seeds}`
  cross-product that order groups a regime's seeds together, and carrying state across five
  consecutive `depeg` epochs is a friendlier experiment than carrying it across a schedule that
  returns to `depeg` every eighth epoch. Generate the plan and replay that instead:

  ```bash
  npm run competition -- plan --hidden hidden.yaml --lottery lottery.yaml --k 40 --out plan.yaml
  npm run backtest -- --scenarios plan.yaml --agent-state-root runs/state
  ```

## What the environment guarantees, and what it does not

- **Guaranteed:** the directory is per participating unit, private to it, and survives every epoch.
  Two submissions from one unit (§2.2) are two agents with two directories.
- **Not guaranteed:** that what is in it still works. A strategy persisted last epoch is untrusted
  input this epoch — it goes through the cheatcode static check and the vm compile again at load,
  and a failure falls back to `agent.ts` with `revision_resume_failed` in the agent log. An agent
  that persists a broken strategy starts every epoch broken until its next revision, which is the
  participant's risk to carry.
- **Not guaranteed:** that reading it is free. An agent that persists a large log and reads it at
  start is spending its own first-decision budget; blocks are two seconds long.
- **Unchanged:** `ERIS_AGENT_FROZEN: "1"` ignores the state directory as well as `prompt.md`. The
  frozen control has to start from version 0 every epoch or it is not a control.
