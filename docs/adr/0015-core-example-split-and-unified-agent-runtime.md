# ADR 0015: core/example パッケージ分離と agent ランタイム一本化（directShim/relay 廃止）

## Status

Proposed

## Context

本 repo は Anvil で Arbitrum をフォーク（またはローカルデプロイ）する DeFi トレード競争シミュレータであり、
ADR 0006 により環境プロセス（coordinator = 環境デーモン + 採点者）と agent プロセスは分離済みである。
両者の契約はすでに「env 変数（`ERIS_RPC_URL` / 秘密鍵 / PriceFeed アドレス / `ERIS_RUN_DIR`）＋
オンチェーン状態＋ `runs/<id>/agents/<id>.jsonl`」に絞られている。

一方でコード配置はこの境界を反映していない:

- `src/` に環境側（coordinator / anvil / 採点 / flow / stress / vuln）と agent 側部品
  （`chain.ts` / `action.ts` / `protocols/*` / `llm/*`）が同居し、`examples/` は 21 種の
  `../../src/...` import で `src/` に深く依存している
- 逆方向の依存もある。`src/realtime/agentProcess.ts` が `examples/agents/lib/directShim.ts` を
  ハードコードで `--import` 注入しており、環境→example の参照が存在する。また
  `examples/flow/market-maker.ts` は実態が環境側の市場機構なのに examples に置かれている
- LLM プロンプト（`SYSTEM_PROMPT` / `SIM_RULES`）は `src/llm/prompts.ts` に直書きで、
  agent ごとの個別化は `agents[].env`（`ERIS_LLM_*`）経由の間接的な仕組みしかない
- 本番コンペの提出形式は「zip bundle = プロンプト＋汎用スクリプト」（ADR 0003/0004 の前提）だが、
  現在の `examples/` はそのままコピー・提出できる単位になっていない

### 解決したい課題

- 環境（core）と参加者テンプレート（example）の境界をコード配置・依存方向として強制したい
- 参加者が「プロンプト 1 枚を書けば agent が増える」体験を作りたい（提出 bundle の雛形）
- `examples/agents/` を丸ごとコピーしても import が壊れない構造にしたい
- directShim（stdin/stdout 差し替え + spawn 時 `--import` 注入）という暗黙の魔法が
  新規参加者・保守の双方で混乱源になっており、排除したい

### 検討した選択肢

**軸 1: パッケージ戦略**

| 観点 | A. npm workspaces 3 分割 | B. 同一パッケージ内ディレクトリ分割 | C. example を完全独立 repo 相当に |
|------|--------------------------|-------------------------------------|-----------------------------------|
| 依存方向の強制 | package.json レベルで強制 | lint/CI ルール頼み | 最強（物理分離） |
| コピー時の import 生存性 | `@eris/sdk` 参照で生存 | 相対パスが壊れる | 生存（ただし sdk の二重管理） |
| 移行コスト | 中 | 小 | 大 |
| 開発イテレーション | 単一 repo のまま | 単一 repo のまま | 重い（cross-repo 変更） |

**軸 2: レガシー戦略（既存 34 体）の互換**

| 観点 | directShim 維持（無改修互換） | decide() 契約へ移行（シム削除） |
|------|-------------------------------|--------------------------------|
| 既存戦略の改修 | 不要 | 全 31 体（自前 readline 29 + ヘルパー利用 2）に機械的改修 |
| 仕組みの説明しやすさ | stdin/stdout 差し替え + 注入の魔法が残る | 「bot.ts がループの持ち主」で一目瞭然 |
| プロセス間プロトコル | stdin/stdout JSON 行（暗黙） | なし（関数呼び出しのみ） |
| relay モードのロールバック | 維持可能 | 廃止になる（stdin/stdout プロトコル自体が消える） |

**軸 3: runtime（汎用スクリプト）の配置**

| 観点 | agents/ 直下に共有 1 つ | 各 agent ディレクトリに実コピー | bundle 時のみ vendoring |
|------|--------------------------|--------------------------------|--------------------------|
| 修正の伝播 | 正本 1 箇所 | 全 agent へ手動伝播（ドリフトバグ源） | 正本 1 箇所 |
| コピペ自己完結性 | agents/ ごとコピーで成立 | agent 単体で成立 | bundle 生成まで得られない |
| repo の重複 | なし | agent 数に比例 | なし |

## Decision

**repo を core / sdk / example の 3 workspace に分離し、`example/agents/` を「1 agent = 1 ディレクトリ」の
コピー・提出単位とし、agent 実行を `runtime/bot.ts` の decide() / prompt.md 契約に一本化して
directShim と relay モードを廃止する。**

軸 1 は A（workspaces）、軸 2 は decide() 移行、軸 3 は共有 runtime を採用する。
コピー時の import 生存性が要件である以上 B では成立せず、シムを消すなら stdin/stdout
プロトコルごと消して契約を関数に置き換えるのが最も説明可能性が高い。

### 1. パッケージ構成と依存方向

```
eris-competition-poc/            # npm workspaces ルート
├─ core/                         # 環境デーモン + 採点（参加者は触らない）
│  ├─ realtime/                  #   coordinator, anvil, priceFeed, events(stress),
│  │                             #   vulnEvents, reconstruct, agentProcess
│  ├─ flow/                      #   flow logic + flowProcess + market-maker bot（examples から移動）
│  ├─ cli/                       #   sim-realtime, anvil
│  └─ runConfig / postRunCheck / strategyStaticCheck
├─ sdk/                          # 両者が依存する契約レイヤ（@eris/sdk）
│  ├─ types.ts                   #   AgentObservation / AgentAction
│  ├─ action.ts                  #   action スキーマ・validate
│  ├─ constants / markets / abis / chain.ts
│  └─ protocols/                 #   venue アダプタ（readState / buildTxs / valueUsdc）
├─ example/
│  └─ agents/                    # ← この 1 ディレクトリがコピペ/提出の単位
│     ├─ runtime/                # 汎用スクリプト（正本 1 つ。基本さわらない）
│     │  ├─ bot.ts               #   全 agent 型の唯一のエントリポイント
│     │  ├─ read.ts              #   オンチェーン読取（observation 再構成。旧 shim の読取側）
│     │  ├─ send.ts              #   署名・送信・nonce 管理・mempool 自己申告（旧 shim の送信側）
│     │  ├─ deploy.ts            #   参加者コントラクト deploy（flash-arb executor 等）
│     │  ├─ llm.ts               #   素の LLM 呼び出し 1 関数（プロバイダ切替のみ）
│     │  └─ agentLog.ts
│     ├─ arb-bot/agent.ts        # ルール戦略
│     └─ my-arb/prompt.md        # プロンプト型 agent
└─ deployer/                     # venue デプロイは環境側（現状のまま）
```

依存方向は **`example → sdk ← core`** のみ。core⇔example の直接参照は禁止し、CI で検査する。
venue デプロイ（環境の仕事 = `deployer/`）と参加者コントラクトのデプロイ（`runtime/deploy.ts`）は別物として扱う。

### 2. agents/ ディレクトリ規約

1 agent = 1 ディレクトリ。中身は次のいずれか 1 枚（両方置かれた場合は `agent.ts` 優先）:

| 中身 | 種別 | 動き方 |
|------|------|--------|
| `agent.ts`（`decide` export） | ルール戦略 | bot.ts が read→decide→send のループで駆動 |
| `agent.ts`（`run(ctx)` export） | 自走型 | bot.ts はループせず ctx（clients/read/send/log）を渡して委譲 |
| `prompt.md` | プロンプト型 | bot.ts が observation を添えて LLM に action を出させる |

`runtime/` は予約名であり agent ではない。`params.json` のような構造化パラメータファイルは設けない
（戦略パラメータはコードまたはプロンプト本文が持つ）。

### 3. agent 契約: プロセスから関数へ

stdin/stdout プロトコルを廃止し、戦略は関数を export するモジュールになる:

```ts
// Bad（従来）: 自前 readline ループ + stdout 書き出しの定型文（29 体がこの形）
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const action = decideInner(obs);
  if (action) process.stdout.write(`${JSON.stringify(action)}\n`);
});
```

```ts
// Good（本 ADR）: agents/arb-bot/agent.ts
import type { AgentObservation, AgentAction, AgentContext } from "@eris/sdk";

export const config = { intervalMs: 2200 };   // 任意（旧 runRealtimeAgent の間隔/位相）

export function decide(obs: AgentObservation, ctx: AgentContext): AgentAction | null {
  // 判断ロジックのみ。null = 見送り
}
```

liquidator のように RPC を直接叩き自分のタイミングで動く戦略は `run(ctx)` を export する
（完全自走を許しつつ read/send/log は runtime のものを使わせる）。

### 4. プロンプト型 agent: prompt.md 1 枚

既存の LLM 機構（executor 生成・revision・attribution・baseStrategies シード。ADR 0002 系）には
準拠しない。新ランタイムは「毎判断 LLM」の素直なループとする:

```markdown
---
name: my-arb                                            # 必須
description: cross-venue 裁定。30bps 超で fair へ寄せる   # 必須
intervalMs: 5000        # 任意 frontmatter（省略時は既定値）
model: gpt-oss:120b     # 任意
---
あなたは cross-venue 裁定 bot。
- fair と pool の乖離が 30bps を超えた venue で、fair へ寄せる方向に swap する
- 1 回の notional は最大 2 WETH、priority fee は期待利益の 10% まで
```

frontmatter は Agent Skills 標準（agentskills.io。skill = フォルダ + SKILL.md + 必須 `name`/`description`）
と同じ形に寄せる。`name`/`description` は必須（ロスター表示・ログヘッダに使用）、未知フィールドは無視
（前方互換）。

LLM 判断サイクルは Nous Research の Hermes 実装（Hermes-Function-Calling）で実証済みのパターンを採用する:

1. `runtime/prompt.ts` が合成: system =「JSON mode 指示 +
   `<schema>{action の JSON Schema}</schema>` + 環境ルール（固定文）+ prompt.md 本文」、
   user =「最新 observation + agentLog 由来の直近の行動と結果」。`<schema>` 形式は
   ollama 系オープンモデルの学習分布（Hermes JSON mode）に合わせたもの
2. `runtime/llm.ts` がプロバイダ分岐: ollama 系 → JSON mode、claude/codex 系 → ネイティブ
   structured output / tool use。prompt.md は出力形式を一切意識しない
3. `runtime/bot.ts` が sdk の `validateAction` で検証。失敗時は**エラー内容（何がスキーマ違反か）を
   会話に追記して再試行**（上限 3〜5 回）、超過はそのサイクルを見送り（noop）として agentLog に記録する
   （fail-closed: 不正 action はチェーンに出ない）

`<schema>` と `validateAction` は sdk の action スキーマ（zod 化。§8 参照）という同一オブジェクトから
導出するため、「LLM が教わったルール」と「実行時に強制されるルール」は構造的に一致する。
レイテンシ/コストは `intervalMs` で調整する割り切り。旧 `src/llm/*` は新 runtime から依存せず、
`agents/claude-llm/` 配下に引き取るか `_archive/` へ移す。

### 5. directShim / relay の廃止（ADR 0006 の一部改訂）

- `directShim.ts` を削除する。観測再構成は `runtime/read.ts`、署名・送信・mempool 自己申告
  （ADR 0006 §5）は `runtime/send.ts` へ分解して引き継ぐ
- `agentProcess.ts` のシム `--import` 注入を削除し、spawn は一律
  `node --import tsx example/agents/runtime/bot.ts`（agent ディレクトリは env で渡す）。
  これで core→example のハードコード参照が消える
- stdin/stdout プロトタイプ廃止に伴い **relay モード（`ERIS_AGENT_DIRECT_TX=0` ロールバック）も撤去**する。
  direct モードへの一本化を確定させる（`src/config.ts` / `runConfig.ts` / `coordinator.ts` の分岐削除）

### 6. config の規約解決

ディレクトリ規約により、ロスターは `id` からエントリを自動解決できる（明示 `command`/`args` は override として残す）:

```yaml
# Bad（従来）                                  # Good（本 ADR）
- id: arb-bot                                  - id: arb-bot
  command: node                                  wallet: AGENT2_PRIVATE_KEY
  args: [--import, tsx, examples/agents/arb-bot.ts]
  wallet: AGENT2_PRIVATE_KEY
```

### 7. コピペ・提出運用

- 日常のコピー単位は `example/agents/` ディレクトリ丸ごと（runtime + 全 agent が同梱される）
- runtime の sdk 参照は `@eris/sdk` のパッケージ名 import とし、コピー先でも `npm install` で解決する
- 提出用に `bundle:agent <id>`（runtime + sdk 必要分 + 対象 agent ディレクトリを自己完結 zip に固める
  スクリプト）を用意する

### 8. 実装言語は TypeScript を維持する

core / sdk / example とも TypeScript を維持する。sdk の action スキーマは sdk 切り出し時に
zod 化する（現行 `action.ts` は手書き検証。zod 4 の `z.toJSONSchema()` で §4 の `<schema>` を生成）。

- **core**: 計算エンジン（anvil/forge）は既に Rust であり、TS 層は IO バウンドのオーケストレーション。
  実測でも律速は常に fork RPC / anvil 実行側で、TS が律速になった局面はない
- **example**: TS は設計上の必然。`decide(obs: AgentObservation)` への型伝播（observation 直読みの
  TypeError noop 事故のコンパイル時検出）、`send.ts` からの sdk アダプタ（buildTxs）再利用、
  「コピーして `npm install` で動く」単一ツールチェーンの 3 点が example の TS を前提にする。
  Python 化の 2 経路（Python 版 sdk の複製 / プロセス間ブリッジ）は、それぞれ sdk の単一ソース性・
  stdin/stdout プロトコル廃止（§5）と矛盾する
- **逃げ道**: env 契約（`ERIS_*`）はプロセスレベルで言語非依存のまま。config の明示 `command`
  override で完全自前の他言語 agent を spawn する道は残す（read/send/validate 全部自前 = サポート外の
  上級者向け）
- **再検討トリガー**: オフライン大量シミュレーション（RL 学習等）が要件になった場合は、既存 TS の
  書き換えではなく anvil を介さない専用エンジンを別コンポーネントとして追加する

## Consequences

### Positive

- 参加者体験が「`agents/` にディレクトリを作って prompt.md を 1 枚書く → ロスターに id を足す → run」まで縮む
- 環境⇔agent の境界がパッケージ依存として強制され、core→example のハードコード参照が消える
- stdin/stdout 差し替え・`--import` 注入という暗黙の魔法が消え、「bot.ts がループの持ち主」と一目で分かる
- 各戦略ファイルから readline 定型文が消えて短くなる。config ロスターも `id` + `wallet` の列挙に痩せる
- `example/agents/` がそのまま本番コンペの提出 bundle（プロンプト＋汎用スクリプト）の雛形になる

### Negative

- 既存 31 戦略（自前 readline 29 + `runRealtimeAgent` 利用 2）全てに改修が必要
  - → 変更は完全に同型（readline 定型文を削り中心ロジックを `decide()` へ括り出す）。数体をサンプル移植して
    テンプレを固め、残りを一括変換する
- relay モードのロールバック経路が消える
  - → direct モードが既定になって久しく、シム削除は direct 一本化の宣言。問題が出た場合は git 履歴から復元可能
- workspaces 化で tsconfig / package.json / spot skills のパス前提が動く
  - → env 契約（`ERIS_*`）と `runs/<id>/agents/*.jsonl` のログ形式は一切変えないため、
    coordinator 側と spot AMI への影響はパス更新に限定される
- 旧 `src/llm/*`（自己改善機構）が新 runtime から切り離される
  - → 破棄はせず `agents/claude-llm/` 配下または `_archive/` に温存。自己改善の再開時に再接続を判断する

### Risks

- 「固定のルール説明」（旧 SIM_RULES）が sdk の型とドリフトする
  - → action の形式は zod スキーマから `<schema>` を生成するため構造的に一致（§4/§8）。
    残る自然言語部分（observation の説明・制約の文章）は sdk の型定義と同一パッケージに併置し、
    形が変わる PR で必ず同時更新する
- core が sdk を経由せず example を参照する退行
  - → import 境界の CI チェック（`no-restricted-imports` 相当）を workspaces 分割と同時に入れる
- 毎判断 LLM のプロンプト型 agent はレイテンシ/コストが実用に耐えない可能性
  - → `intervalMs` での間引きを既定とし、実測して不足なら「起動時に decide() コードを生成する」方式を
    追加検討する（本 ADR では採らない）

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| 既存 34 戦略の現役/アーカイブ仕分け | ロスター yaml と `ERIS_BASE_STRATEGY` の参照を洗えば機械的に決まる作業であり、設計判断ではない | 移行実装時 |
| `bundle:agent` の zip 内容の詳細（sdk の同梱範囲等） | 本番コンペの提出仕様の確定待ち | 提出仕様が固まった時点 |
| 旧 `src/llm/*` 自己改善機構の最終的な行き先 | 自己改善は現在凍結中（強化は env α支配化の後の方針） | 自己改善を再開する時点 |
| protocols アダプタを参加者が改造可能にするか | 提出物の自由度（＝競争ルール）の問題であり、アーキテクチャでは決まらない | コンペルール策定時 |

## Notes

### 参考資料

- ADR 0006: 環境（市場機構）とエージェント実行の分離 — 本 ADR は §2（directShim による無改修互換）と
  relay ロールバックを廃止する一部改訂。プロセス分離・direct チェーンアクセス・§5（mempool 自己申告）の
  原則は維持・強化する
- ADR 0002: LLM 戦略自己改善（旧 LLM 機構。新 runtime は準拠しない）
- ADR 0003 / 0004: 提出 bundle（プロンプト＋汎用スクリプト）形式の前提
- ADR 0013: マルチアセット取引ペア対応（observation 正規化。sdk へ移る `markets` の由来）

### 参考実装（外部）

- [NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) —
  §4 の JSON mode `<schema>` システムプロンプト形式と「エラー内容を添えた validate 再試行
  （上限付き）」の出典。ollama 系オープンモデルの学習分布に合わせるための一次ソース
- [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) —
  「汎用ハーネス + markdown 1 枚（SOUL.md）が人格を規定」という本 ADR と同型の分割の先行例。
  provider 層の tool-call parser 群・sandbox backend 抽象は本番コンペでの拡張時の参考
- [Agent Skills 標準（agentskills.io）](https://agentskills.io/) — §4 の frontmatter
  必須フィールド（`name`/`description`）の互換先
- [benedictbrady/amm-challenge](https://github.com/benedictbrady/amm-challenge) — 対照的な設計
  （同期決定論 + 単一 .sol 提出 + paired normalizer 常時並走）。「採点を同一 run 内 baseline との
  差分で報告する」「提出前ローカル検証 CLI」は将来の取り込み候補
