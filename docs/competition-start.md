[← README](../README.md) ｜ English: [`competition-start.en.md`](competition-start.en.md)

# 参加者スターターガイド

**最初のエージェントを提出できる形にするまでの一直線。** 30 分で動くところまで行きます。

規則そのものは [ascon.dev/rules](https://ascon.dev/rules) が唯一の出典です。本書と食い違ったら規約が優先します。本書は「どう作るか」だけを書きます。本書は日本語が正文で、[英語版](competition-start.en.md)は参考訳です。

**必要なもの**: Node.js 20 以上 / [Foundry](https://book.getfoundry.sh/getting-started/installation)（`forge` と `anvil`）/ `git` / `zip`（提出 zip の作成に使います）。

---

## 1. 競技の形

```
競技全体
 └ エポック  ×k        1 つの世界。全参加単位が同一の初期条件から同時に始まり、
    │                  360 ブロック（1 ブロック 2 秒 = 12 分）走って終わる
    │                  エポックごとに世界はリセットされる。在庫も損益も繰り越さない
    │
    ├ シナリオ          そのエポックが再生する市場 =（レジーム, 乱数シード）
    │                  レジームは市場条件の型。どのエポックがどのレジームかは事前に知らされない
    │
    └ 評価区間 ×29      12 ブロックごとの区切り。リーダーボードの途中経過に使う。
                       採点には使わない
```

> **360 / 12 / 29 は現行コードの値です。** 規約の付録 A は「1 エポックあたりのブロック数」「評価区間のブロック数」「k」「ガス用 ETH」を**提出期間の開始（2026-09-23）までに公表**としています。ここに書いた数字は公式レジーム（`config/regimes/*.yaml` の `blocks: 360`）と sdk の既定値（評価区間 12 ブロック）で、公表値と食い違ったら規約が正です。

**採点は 1 エポックにつき数字 1 つだけです。**

```
損益 P   = エポック終了時の資産価値 − 開始時の資産価値（USDC 建て）
偏差値 T = 50 + 10 ×（P − 全参加単位の平均）/ 標準偏差
最終    = 後のエポックほど重い加重平均（最初 1.0 → 最後 1.5）
```

つまり **「その回、他の全員と比べてどうだったか」を k 回積み上げる**競技です。エポックの途中でいくら含み益が出ても、終了時の資産価値にしか意味がありません。相場全体の値動きは全員の平均に吸収されるので、**上げ相場で得をすることも下げ相場で損をすることもありません**。

初期資本は全参加単位に同じものが配られます: **8 WETH + 0.4 WBTC + 25,000 USDC**、加えてガス用の ETH。何も動かさない参照エージェント（ベンチマーク）が 1 体置かれます。全参加単位は同じ 1 本のチェーンで同時に走ります。

> **ローカルの `npm run backtest -- --scenarios` は本番と同じ式で順位を出します**（1 シナリオ = 1 エポック、P → 偏差値 T → 後半ほど重い加重平均。`standings.json`）。違うのは場です:
> ローカルの母集団は自分のロスターで、本番は全参加者。**ローカルの数字は「自分の版どうしを比べる」ためのもので、本番の順位の予測ではありません。**

### 用語の対応表（重要）

**規約とコードで同じ言葉が別の意味を持ちます。** ここだけは覚えてください。

| 規約の用語 | コードでの呼び名 | 実体 |
|---|---|---|
| エポック | run | `runs/<id>/` 1 個 ＝ `summary.json` 1 枚 |
| シナリオ | scenario | `<regime>#<seed>`。`config/regimes/*.yaml` が regime の定義 |
| 評価区間 | **epoch** / ダッシュボードの「ラウンド」 | `summary.json` の `valueSeries.epochSeries`、`run.epochBlocks`（既定 12）。採点には使わない |

**コードの `epoch` は規約の「エポック」ではありません。** コードの `epoch` は規約の「評価区間」です。

---

## 2. セットアップ

```bash
git clone <repo> && cd eris-competition-poc
npm install
cp config/example.yaml config/local.yaml   # run 設定とロスター
cp .env.example .env.local                 # 鍵と RPC（ローカルは Anvil の開発鍵でよい）
npm run build:contracts                    # PriceFeed とモックオラクルを forge build（初回のみ）
```

全 venue をローカル anvil にデプロイします（初回は GMX の clone 取得で数分かかります）。

```bash
# --- ターミナル A（初回のみ）---
cd deployer
npm install && forge build
cp .env.example .env
./scripts/setup-vendors.sh
```

**デプロイは専用のターミナルで動かし続けます。** `npm run deploy` は anvil を生かしておくために
**意図的に終了しません**（`deployer/src/index.ts`）。同じブロックに続けてコマンドを書くと、
それらは実行されません。

```bash
# --- ターミナル A（デプロイ。ここは開いたまま）---
cd deployer && npm run deploy -- --keep-fresh
```

デプロイ完了のログが出たら、**別のターミナル**で続けます。

```bash
# --- ターミナル B ---
npm run gen:local-constants               # deployments.json → sdk/src/constants.local.ts
npm run sim:realtime
```

`runs/<id>/` が生まれ、`summary.json` に各エージェントの結果が入れば成功です。

> **焼き直すときは anvil ごと立て直してください。** `--keep-fresh` が消すのは `deployments.json` だけで、同じ anvil に 2 回流すと WETH の wrap で `insufficient funds` になります。

---

## 3. 提出できる最小のエージェント

**1 エージェント = 1 ディレクトリ**です。テンプレートを複製してください。

```bash
cp -r example/agents/my-arb example/agents/my-strategy
```

中身は 2 ファイルです。**ランタイムは `agent.ts` だけでも起動しますが、規約 §2.5 が `prompt.md` を要求するので、提出するには両方要ります。**（`prompt.md` が無いエージェントはローカルでは普通に走ります — 落ちるのは `prompt.md` が**あるのに** `kind: improve` が無いときです。）

```
example/agents/my-strategy/
  agent.ts     毎ブロック動く戦略本体
  prompt.md    LLM が戦略コードを書き換えるときの方針（規約 §2.5 で必須）
```

**ディレクトリを作っただけでは誰も起動しません。** `config/local.yaml` のロスターに id を足してください。

```yaml
agents:
  - id: my-strategy          # example/agents/my-strategy/ を指す
    wallet: AUTO
```

これで `npm run sim:realtime` があなたのエージェントを起動します。ディレクトリ名と違う id を使いたいときは `dir:` で実体を指します（同じ戦略をパラメータ違いで複数走らせるときに使います）。

### `agent.ts` — 戦略

```ts
import type { AgentAction, AgentObservation } from "@eris/sdk";

export function decide(obs: AgentObservation): AgentAction | null {
  return { type: "noop", reason: "まだ何もしない" };
}
```

これが契約の全部です。

- 返り値がアクションなら、ランタイムが**署名・送信の前に検証**します。**どちらの失敗もチェーンには届きません**（fail-closed）。形が壊れていて schema を通らなければ `agents/<id>.jsonl` に `bad_action`、形は通ったが中身が通らなければ `rejected` が残ります
- `null` を返すと見送りです。**何もしないのは正当な選択**です（機会が無い相場で取引しないのは正解）
- 例外を投げても run は壊れません。そのラウンドが飛ばされ、ログに `decide error:` が残ります

> **提出するエージェントは `decide()` で書いてください。** ランタイムには `decide` の代わりに
> `run(ctx)` を export して自前のループを回す形式もありますが（例: `liquidator`）、
> **`run(ctx)` と `prompt.md` は共存できません** — 自己改善は `decide` を差し替える仕組みなので、
> 両方あると起動時に exit 1 します（`example/agents/runtime/bot.ts` がその旨のエラーを出します）。規約 §2.5 が
> `prompt.md` を必須にしている以上、`run(ctx)` 形式は現状では提出できません。

### `prompt.md` — 改訂方針

**frontmatter の `kind: improve` が必須です。無いと起動時に落ちます。**

```markdown
---
kind: improve
name: my-strategy
description: 一行で戦略を説明する
reviseEveryBlocks: 60
---

このファイルは「毎回の取引判断」ではなく「**いつ・何を根拠に・どう戦略コードを直すか**」を書く場所です。

## この戦略が前提にしている事実
（LLM が壊してはいけない前提を書く）

## 直してよいところ / 直してはいけないところ
（閾値やサイズは可、二段執行の順序は不可、など）
```

> **なぜマーカーが要るか。** 過去に「この観測でどう動くか」を書く同名の `prompt.md` があり、frontmatter のキーまで同じでした。区別できるのは `kind: improve` だけなので、無いものは黙って読まずに落とします。読んでしまうと、取引指示が「改訂方針」として system prompt に入ります。

`reviseEveryBlocks` は改訂を試みる間隔（既定 60 ブロック）。**最初の観測は基準点として使われ、改訂は起きません**（戦績がまだ無いのに 1 回消費するのを避けるため）。したがって 360 ブロックの間隔は 359 で、既定なら **1 エポックあたり 5 回**です。

---

## 4. 観測と行動

`obs` はランタイムが毎ブロック再構成する**確定済み状態のスナップショット**です。RPC を自分で叩く必要はありません。

```ts
obs.fairPriceUsdcPerWeth        // 環境が配布する参照価格（オンチェーンの PriceFeed 経由）
obs.protocols.uniswap.pool      // venue ごとの状態
obs.balances                    // 自分の残高。stables は内訳付き
obs.limits                      // priority fee の既定値と上限、slippage の既定値。サイズの上限は入っていない
```

**observation に入らないもの**: 未確定の注文、次のブロック、イベント窓の位置。全員が同じ遅延で同じものを見ます（`PriceFeed` への書き込みは次ブロック着弾なので、参照価格は常に 1 ブロック遅れます）。

ただし 2 つ補足があります。**直近ブロックで他者が払った最大 priority fee は observation に入ります**（`obs.competition.maxCompetitorPriorityFeeWei`。確定済みブロックの履歴であって、未確定の注文ではありません）。また `decide(obs, ctx)` の `ctx` には `publicClient` / `walletClient` が渡されるので、**ノードを直接叩くこと自体は禁止されていません**。何が許されるかは規約 §8（禁止行為）が定めます。

**取引サイズの上限はありません。** どの venue にも 1 件あたりの金額上限・バンドル内のアクション数の上限・建玉数の上限は無く、`obs.limits` にもサイズの予算は入っていません（以前あった `maxWethInWei` / `maxUsdcInUnits` / `maxBundleActions` / `maxOpenPositions` は 2026-09-02 に撤廃されました。引き上げではなく撤廃です）。1 件の取引を縛るのは**自分の残高**と**相手プールの厚み**だけで、大きく出すほど不利な約定になります。サイズは自分で決めてください。共有ヘルパは `example/agents/lib/affordable.ts` の `sized(obs, token, bps)`（残高の割合で切る）です。

**制限は 2 種類あり、効き方が違います。**

| どこから来るか | 何が制限されるか | 破るとどうなるか |
|---|---|---|
| ランタイム（送信前に検証する） | アクションの形と中身（schema・在庫の無い側の leg）、priority fee（`obs.limits.maxPriorityFeePerGasWei`）、**ガス**（tx 1 本 30,000,000 gas、1 エージェント 1 ブロック合計 30,000,000 gas） | 送信前に**拒否**され、`agents/<id>.jsonl` に `rejected` が理由付きで残る（ガスは `tx gas cap` / `per-block gas budget`）。チェーンには届かない |
| 規約 §2.3・§2.6（運営が課す） | 判断ごと **5,000 ミリ秒**、**2 vCPU / メモリ 4 GB**（§2.3）。**1 ブロックあたりの tx 本数に上限は無い**（§2.6。ブロックに入るかは priority fee のオークションで決まり、ブロックのガスリミットは 30,000,000） | タイムアウトはそのブロックが行動なし、異常終了はエポックの残りが行動なし（再起動しない）。**`obs.limits` には出ません** |

前者はランタイムが止めます。**後者は自分で守る必要があります**。

アクションの一覧と各 venue の詳細は [protocols-and-actions.md](guide/protocols-and-actions.md)、`obs` の全フィールドは [writing-agents.md](guide/writing-agents.md) にあります。

---

## 5. LLM による戦略改訂

規約は**全エージェントに戦略改訂の構成を要求します**。LLM は取引経路の外にいて、`reviseEveryBlocks` ごとに自分の戦績と現在のコードを見て、書き換えるかどうかを決めます。

生成されたコードは **cheatcode 静的検査 → コンパイル**（関数式の評価に 1 秒の上限）を通ってから設置されます。**設置前に試運転はしません。** 設置後は、手書きの戦略と同じく `decide` の**呼び出しごとに 5 秒**（規約 §2.3）の上限がかかり、超えるとそのラウンドは行動なしとして `decide timeout:` で記録されます（`DECIDE_TIMEOUT_MS`）。落ちた改訂は設置されず、記録が残って戦略は無改変で走り続けます。自動 rollback はありません。戻すかどうかはモデルの判断です（版履歴を渡して `revertTo` で行う）。

ロスターの `env` で指定します。

```yaml
agents:
  - id: my-strategy
    wallet: AUTO
    env:
      ERIS_LLM_MODEL: "claude-cli"       # ローカル開発ではサブスクの CLI が使える
      ERIS_IMPROVE_LOG_CALLS: "1"        # 生のやり取りを agents/<id>.llm.jsonl に残す
```

**現在サポートしているバックエンド**:

| 指定 | 何を使うか | 認証 |
|---|---|---|
| `codex` / `codex:<model>` | `codex exec` を起動 | ChatGPT サブスク（`codex login`） |
| `claude-cli` / `claude-cli:<model>` | `claude -p` を起動 | Claude サブスク |
| `claude...`（`claude` で始まるモデル名） | Anthropic API | `ANTHROPIC_API_KEY` |
| `openai:<model>` または `gpt-` / `o1` / `o3` / `o4` で始まるモデル名 | OpenAI 互換 chat completions | `OPENAI_API_KEY`（互換エンドポイントは `OPENAI_BASE_URL`） |
| それ以外（既定） | Ollama 系 | `ERIS_OLLAMA_BASE_URL`（既定 Ollama Cloud）+ `OLLAMA_API_KEY` |

> **本番では鍵はエージェントに渡りません。** 推論は運営のプロキシ経由で（規約 §2.3・§2.5）、使えるモデルはプロキシの一覧（§2.5 で公表）に限られ、全ての往復が記録されます。ローカルで `ERIS_INFERENCE_BASE_URL` を設定すると同じ経路を試せます（`infra/inference-proxy/README.md`）。

バックエンドが無くても run は完走します。改訂の失敗が記録され、戦略は無改変で走り続けます。詳細は [llm-agents.md](guide/llm-agents.md)。

---

## 6. 自分で検証する

**1 本のシナリオを再生する**（`--seed` は必須です。シナリオ =（レジーム, シード）なので、レジームだけでは決まりません）。

```bash
npm run backtest -- --regime crash --seed 101 --agents config/rosters/full-field.yaml
```

**公開セット全部を回して順位を出す**。

```bash
npm run backtest -- --scenarios config/scenarios/public.yaml --agents <あなたのロスター>
```

公開セットは**分布からの数本のドローであって、目標ではありません**。生成器は公開されているので、**自分でシードを引いて確かめてください**。公開シードに合わせ込むと、非公開セットで別のドローに当たった瞬間に崩れます。

見るもの:

| どこ | 何が分かる |
|---|---|
| `runs/<id>/agents/<id>.jsonl` | 毎ラウンドの判断理由・送信・拒否。**まずここを読む** |
| `runs/<id>/summary.json` | 損益・違反・エージェントごとの結果 |
| `npm run dashboard` | 順位・ラウンド別の推移・venue の状態・リプレイ |

---

## 7. 練習 devnet（任意）

止まらないチェーンに、自分のマシンからエージェントを繋いで走らせられます。**公式採点ではありません** — 練習期間の結果は順位に一切反映されません。

運営が配る `manifest.json`（RPC・チェーン ID・全 venue アドレス・ラウンド長・アクション語彙・手数料の既定値。**発注上限は無いと明記されています**）と、自分のウォレットだけで参加します。判断ログは**あなたのマシンにしか残りません**。手順は [practice-devnet.md](guide/practice-devnet.md)。

練習で身につくのは執行と観測の扱いです。**エポックのリセットと偏差値による採点は練習には存在しません**。そこは本番だけの構造です。

---

## 8. 提出

送信前に必ず通してください。

```bash
npm run typecheck
npm run check:strategy          # cheatcode の静的検査（入口ゲート）
npm run backtest -- --scenarios config/scenarios/public.yaml --agents <あなたのロスター>
npm run bundle:agent my-strategy
```

`bundle:agent` は `prompt.md`（frontmatter に `kind: improve` / `name` / `description`）の無いディレクトリを**拒否します**。規約 §2.5 が全提出エージェントに戦略の改訂を求めるためで、ルールだけの `decide()` は動きはしますが提出物にはなりません。

**資源の上限を自分で確かめられます。** 本番では各エージェントが規約 §2.3 の上限（2 vCPU / メモリ 4 GB）を掛けたコンテナで動きます。**同じイメージと同じ上限**でローカル検証できます。

```bash
npm run agent:build -- team my-strategy     # 提出用イメージを作る
npm run agent:selftest -- my-strategy       # 同じ上限で短い run を回し、超過していないか見る
```

本番と公式レジームの `npm run backtest` は、このコンテナ経由でエージェントを起動します（`run.agentSandbox: docker`）。docker の無い環境では `--agent-sandbox process` を付けると素のプロセスで走りますが、上限は掛かりません。

上限を超えたエージェントは **OOM-kill** され（`--memory-swap` が `--memory` に固定されているので swap に逃げません）、coordinator には終了コード 137 の早期終了として出ます。**これは「取引しないことを選んだ」記録と区別できません**ので、提出前に確認してください。詳細は [infra/docker-agent/README.md](../infra/docker-agent/README.md)。

`bundle-my-strategy.zip` ができます（ランタイム + sdk + 共有 lib + あなたのエージェントディレクトリ）。

提出期間中は **1 日 5 回まで差し替え**でき、**最終評価の対象を 2 件まで選べます**。2 件を選んだ場合、それぞれ独立に非公開セットで評価され、**スコアの高い方**が最終スコアになります。提出期間の終了をもってエージェントは凍結され、以後はエポック中の LLM 改訂だけが動きます。

---

## 9. よくある失敗（すべて実測）

**在庫の無い側の leg を送る。** USDC しか持っていない状態で売りを出すと、ランタイムが検証で弾き、`rejected` が残ります。チェーンには何も届かないので、**「取引しないことを選んだエージェント」と結果が同一になります**。過去に 4 体がこのバグを抱えたまま出荷されました。`example/agents/lib/affordable.ts` の `canFund` / `affordable` を使ってください。サイズは `sized` で自分の残高の割合として決めます（環境が配るサイズの上限はもう無いので、`obs.limits` から読めるものはありません）。

**`prompt.md` に `kind: improve` が無い。** 起動時に落ちます。エラーメッセージがそう言います。

**`obs` の形を思い込みで読む。** `obs.pool` を直接読むと `undefined` で `TypeError` になり、そのラウンドが飛ばされます。ログに `decide error:` が並んでいたらこれです。正しくは `obs.protocols.uniswap.pool`。

**チェーンに届いていないことに気づかない。** ランタイムは起動時に RPC 疎通・チェーン ID・venue のバイトコードを確認し、駄目なら **exit 1** します。届かないまま生き続けると `includedTxCount: 0` だけが残り、「何もしないことを選んだ」記録と見分けがつきません。

**エポックの途中の含み益を成績だと思う。** 採点されるのは**終了時の資産価値だけ**です。閉じられないポジションは、閉じられないまま評価されます。

---

## 10. 次に読むもの

| 文書 | 内容 |
|---|---|
| [ascon.dev/rules](https://ascon.dev/rules) | **規則そのもの**（唯一の出典） |
| [writing-agents.md](guide/writing-agents.md) | 戦略の書き方の詳細・`obs` の全フィールド |
| [protocols-and-actions.md](guide/protocols-and-actions.md) | venue ごとのアクション一覧 |
| [llm-agents.md](guide/llm-agents.md) | 自己改善の仕組みとバックエンド設定 |
| [backtest.md](guide/backtest.md) | シナリオ再生とシナリオ行列 |
| [stress-events.md](guide/stress-events.md) | 市場ストレスイベントの種類と較正 |
| [dashboard.md](guide/dashboard.md) | 可視化 |
| [docs/spec/](spec/README.md) | 実装の規範的リファレンス（as-built） |
