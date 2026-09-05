[← 目次](README.md) ｜ [← 00 概要](00-overview.md) ｜ [02 実行モデル →](02-runtime.md)

# 01. システム構成

## 1.1 workspace と依存方向

npm workspace 4 つ + workspace 外の deployer サブパッケージ。

| workspace | 役割 | 参加者が触るか |
|---|---|---|
| `sdk/`（`@eris/sdk`） | 契約レイヤ。types / action / observation / protocols / chain / markets / stables / valuation / runConfig | 読む（依存する） |
| `core/` | 環境デーモン + 採点。coordinator / anvil / flow / stress / vuln / backtest / scoring / cli | **触らない** |
| `example/` | 参加者テンプレート。`example/agents/<id>/` がコピーと提出の単位 | 書く |
| `dashboard/` | 観戦 UI（Vite + React）。run 成果物をディスクから読む | 任意 |
| `deployer/` | 全 venue を空の anvil へデプロイする自己完結サブパッケージ（独自 `package.json` / `foundry.toml`） | 実行する |

**依存方向は `example → sdk ← core` のみ**で、`npm run check:boundaries`（`scripts/checkImportBoundaries.ts`）が検査する。`dashboard` は run 成果物と JSON-RPC しか見ないので、この 3 者のいずれにも依存しない — 例外は採点集約 `core/src/scoring/aggregate.ts` の直接 import で、これは**採点ロジックを 2 箇所に置くと CLI と画面で順位が食い違う**ため意図的にそうしている（→ [09](09-dashboard.md)）。

```
example/  ──►  sdk/  ◄──  core/  ──►  runs/<id>/  ◄──  dashboard/
（戦略）      （契約）    （環境+採点）   （成果物）      （UI）
```

## 1.2 プロセス構成

1 回の run で動く OS プロセスは 4 種類。

| プロセス | 実体 | 起動主体 | チェーンへの権限 |
|---|---|---|---|
| **coordinator** | `core/src/realtime/coordinator.ts` | 人間（CLI） | admin / keeper 鍵、cheatcode（anvil 時）、treasury（external 時） |
| **agent × N** | `example/agents/runtime/bot.ts`（`ERIS_AGENT_DIR` で戦略を指す） | coordinator が spawn | 自分の鍵のみ |
| **flow bot** | `core/src/flow/market-maker.ts` | coordinator が spawn | なし（**RPC を触らない**。注文を stdout に書き、coordinator が中継する） |
| **chain** | anvil、または外部チェーン | 人間 / 別途 | — |

```
┌─ coordinator ─────────────────────────┐      ┌─ agent process × N ────────────┐
│ anvil ライフサイクル                   │      │ runtime/bot.ts が一律に駆動     │
│ fair price 生成 → PriceFeed/oracle tx  │      │ read.ts: 毎ブロック observation │
│ flow bot 注文の中継送信                │      │ agent.ts: decide / run          │
│ GMX keeper                             │      │ send.ts: 署名・直接送信         │
│ ストレスイベントの注入                 │      │  （nonce は自己管理）           │
│ エポック境界の採点 / 事後再構成        │      └────────────┬───────────────────┘
└───────────────┬────────────────────────┘                   │
                │  PriceFeed / flow / keeper tx               │ agent tx
                ▼                                             ▼
        ┌──────────────────────────────────────────────────────────┐
        │ chain — 単一 mempool、ブロック内順序は --order fees（降順） │
        └──────────────────────────────────────────────────────────┘
                │ 確定ブロック（observation）        │ 歴史ブロック（採点）
                ▼                                    ▼
             agent                              coordinator
```

### エージェントプロセスへの受け渡し

契約は **env・オンチェーン状態・`runs/<id>/agents/<id>.jsonl` の 3 つだけ**（`core/src/realtime/agentProcess.ts:13-18`）。stdin/stdout プロトコル（旧 relay / directShim）は退役済み。

| env | 内容 |
|---|---|
| `ERIS_AGENT_ID` / `ERIS_AGENT_DIR` | 自分の id と戦略ディレクトリ |
| `ERIS_RPC_URL` / `ERIS_AGENT_ADDRESS` / `ERIS_AGENT_PRIVATE_KEY` | 接続先と自分の鍵 |
| `ERIS_PRICE_FEED_ADDRESS` | fair price の配信先 |
| `ERIS_RUN_ID` / `ERIS_RUN_DIR` / `REPORT_DIR` | ログ出力先 |
| `ERIS_RUN_BLOCKS` | 環境が解決した run のブロック予算（CLI 上書きを子に伝えるため明示的に渡す） |
| ロスターの `env:` / 環境注入の extraEnv | 戦略パラメータ、victim アドレス、vuln factory など |

子プロセスからは `CLAUDE_CODE_*` / `CLAUDECODE` / `AI_AGENT` を削除する（親セッションの入れ子検出でハングするため。`agentProcess.ts:42`）。

## 1.3 公平性の境界

エージェントに**渡らないもの**が仕様の中心にある。

| 渡らないもの | 理由 |
|---|---|
| 他エージェントの秘密鍵 | 自明 |
| pending tx / txpool | mempool を覗く front-run を構造的に不可能にする |
| 未確定ブロックの状態 | 観測は確定済み状態のみ |
| ストレスイベントのスケジュール | 窓の位置は seed 由来の非公開情報（環境マニフェストにも入らない。[10](10-operations.md)） |
| 環境の admin / keeper 鍵 | オラクルを書き換えられてしまう |

一方、**渡るもの**のうち誤解されやすいもの：

- **victim のアドレス**（`ERIS_LIQUIDATION_VICTIMS`）は配布する。オンチェーンで公開情報であり、配布しても「HF を毎ブロック走査する」という検知スキルの前提は保たれる（`coordinator.ts:987`）。
- **whale の資金ウォレット**は setup 時に endow されるので、block 0 の残高を見れば容量が読める。**イベントは反応可能なだけでなく予期可能**であり、それは意図的（`coordinator.ts:1871`）。
- **競合の入札状況**（`obs.competition`）は直近ブロックから自己導出できる情報として渡す。実際の MEV searcher が直近ブロックを見るのと同じ（`sdk/src/types.ts:726`）。

## 1.4 protocol アダプタ層

1 venue = 1 アダプタ（`sdk/src/protocols/types.ts:146` `ProtocolAdapter`）。**環境の採点とエージェントの観測が同じアダプタと同じ `observationFor` を使う**のが要点で、両者が別々の値を見ることが構造的に起こらない。

| メソッド | 呼ばれる場所 | 役割 |
|---|---|---|
| `parse` / `bundleable` / `validate` | agent 側・環境側の両方（純関数） | アクションの解釈と検証 |
| `readState(ctx, fairPrice)` | 毎ブロック（coordinator / agent） | venue の状態読み取り |
| `observe(ctx, state, agent, fairPrice)` | observation 構築時 | `obs.protocols[id]` への寄与 |
| `buildTxs(ctx, owner, action, state)` | 送信時 | 意図 → オンチェーン tx |
| `afterMine(ctx, opts)` | 毎ブロック（keeper 段） | GMX 注文の執行など |
| `valueUsdc(ctx, agent, state, fairPrice)` | run 終了時 | 最終 PnL への寄与 |
| `valueAtBlock(ctx)` | 採点の各横断面 | **段階生成器**（後述） |
| `accountedTokens(publicClient)` | 採点時 | 「このアダプタが既に値付けている」トークンの申告 |
| `setupWallet` / `setupGlobal` | setup 段 | approve 群 / モックのデプロイ・オラクル差し替え |

### `valueAtBlock` が段階生成器である理由

素直な `valueAtBlock(agent, block)` は **agent × protocol ごとに 1 往復**になり、ADR 0006 §4 の「1 ブロック横断面あたり 1 multicall」が崩れる。30 エージェント × 300 ブロックで約 1,500 multicall が約 45,000 RPC 呼び出しになる（`sdk/src/protocols/types.ts:83-87`）。そこで読みたい read を `yield` し、採点側が**全アダプタの stage-N を 1 つの multicall にまとめる**。往復回数は段数に比例し、エージェント数には比例しない。

### 値付けが 2 本あること

`AgentProtocolValue` は `valueUsdc`（額面）と `liquidatableValueUsdc`（実際に手仕舞ったら得られる額）を分けて返す（`types.ts:128`）。**採点が合計するのは後者**（issue #40 公理 3 / ADR 0022 Amendment 1）で、額面のほうが差の出たエージェントだけ `markedValueUsdc` として報告される。食い違うのは LST のキュー滞留・ICR<100% の Trove・裏付けを失った貸付。

## 1.5 チェーン層

`run.chainMode` が 2 値を取る（`sdk/src/config.ts:55`）。

| | `anvil`（既定） | `external` |
|---|---|---|
| cheatcode | 使える（`setBalance` / `setStorageAt` / mining 制御） | **一つも無い**。呼ばれた瞬間に拒否し代替機構を名指しする |
| 資金配布 | 残高の**代入** | treasury EOA からの実送金（**差分補填**） |
| ブロック生成 | 環境が `setIntervalMining` | シーケンサ。環境は実 cadence を計測する |
| リセット | `resetFork` / snapshot-revert | **無い**（練習場ではそれが設計） |

拒否しないと、実チェーンでは未知 RPC がエラーオブジェクトを返すだけで約 30 箇所の呼び出し側の多くがそれを飲み込み、「誰にも資金を配らず、何もマイニングせず、完走した競技として `summary.json` を書く」run になる。→ 起動時の拒否条件は [02 §2.2](02-runtime.md)。

## 1.6 外部依存

| 依存 | 必須か | 無いとどうなるか |
|---|---|---|
| anvil（Foundry） | 必須（`chainMode: anvil` 時） | 動かない |
| `deployer/`（+ `vendor/` の外部クローン） | ローカルデプロイ時に必須 | venue が存在せず `deployment_check` で落ちる |
| Arbitrum RPC（`ARB_RPC_URL`） | fork モード時のみ | ローカルデプロイでは不要 |
| LLM バックエンド（Ollama / Anthropic API / Claude Code CLI / Codex CLI） | 任意 | run は完走し、改訂失敗が記録され戦略は無改変で走る |
| Blockscout（`infra/blockscout/`） | 任意 | dashboard の deep link が消えるだけ |
| forge（コントラクトビルド） | 初回のみ | `out/` が無いと PriceFeed をデプロイできない |

## 1.7 ディレクトリマップ

```
sdk/src/
  types.ts            observation / action / AgentSpec の型（契約の中心）
  action.ts           アクション検証 + ACTION_TYPES_BY_PROTOCOL（run が提供する語彙）
  actionSchema.ts     zod スキーマ（LLM 生成物を含む構造検証）
  observation.ts      observationFor（環境と agent が共有する唯一の構築関数）
  protocols/          アダプタ 7 種 + registry / oracles / marketHelpers / deploy
  chain.ts            クライアント、cheatcode、resetFork、資金配布
  markets.ts          トークンレジストリ（base / kind / decimals）
  stables.ts          市場価格 stable の両側 probe
  valuation.ts        保有 → USDC の変換規則
  runConfig.ts        YAML スキーマ（ネスト lowercase → 内部キー）
  constants*.ts       venue アドレス（fork: constants.ts / local: constants.local.ts = 生成物）
core/src/
  realtime/coordinator.ts   環境デーモン本体（run のライフサイクル全体）
  realtime/liveScoring.ts   エポック境界のその場採点
  realtime/reconstruct.ts   事後の価値系列再構成
  realtime/marketSeries.ts  market.json の再構成（報告専用）
  realtime/events.ts        ストレススケジュール（seed → 窓）
  realtime/{liquidity,stableDepeg,whale,lst,liquity,vulnEvents,vulnPools}.ts  各イベントの実行
  realtime/noArb.ts         無裁定チェック（起動時 + 毎ブロック）
  scoring/{epochScore,metrics,aggregate}.ts  スコア式 / 候補指標 / シナリオ集約
  flow/{logic,market-maker}.ts  orderflow（純関数 / 独立プロセス）
  backtest/{shared,standings}.ts  state dump 検証 / 行列順位
  segments.ts               日次セグメント
  postRunCheck.ts           事後ルール検査
  manifest.ts               環境マニフェスト
example/agents/
  runtime/            bot / read / send / llm / improve / deploy / agentLog（予約名）
  lib/                共有戦略ヘルパ（予約名）
  <id>/               agent.ts（+ prompt.md）
contracts/            PriceFeed / モックオラクル / FlashArb（Foundry）
config/               local.yaml（実体）/ example.yaml（雛形）/ regimes/ / scenarios/ / rosters/
runs/                 run 成果物
```
