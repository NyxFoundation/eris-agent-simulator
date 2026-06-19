# ADR 0008: リアルタイム可視化ダッシュボード（環境を読み取り専用で観測する独立プロセス）

## Status

Proposed（設計のみ。実装は未着手）

## Context

mixed30 ロスター（自己改善 codex 18 + frozen 10 + baseline 2、[[mixed30-roster-plan]]）を回す前に、
**run 中にエージェントの動きをライブで見たい**という要求が出た。現状の観測手段は run 完了後にしか使えない：

- **価値系列（PnL / 順位）は run 後再構成のみ**（ADR 0006 §4 / `src/realtime/reconstruct.ts`）。
  `events.jsonl` の `observation`（10,602件）はすべて `reconstructed:true` で、resetFork 直前に一括生成される。
  → **run 中は順位もエージェントの強さも一切見えない。**
- ライブで追記されるのは `events.jsonl`（`round_timing` 等）/ `blocks.csv` / `agents/<id>.jsonl` の 3 系統だけ。

`discrimination` は regime×replication を**連続実行**し、各 run は数分〜十数分かかる。
回している間、30 体がどう競っているか・どの自己改善 agent が適応しているか・thrash していないかを
**目で追えない**のは検証効率上の損失が大きい。

本 ADR は「**環境を読み取り専用で観測する独立プロセス**」として Web ダッシュボードを導入する設計を定める。

### 設計判断（合意済み）

| 論点 | 決定 | 理由 |
|---|---|---|
| UI 形態 | **Web ダッシュボード**（軽量サーバ + 静的フロント、SSE push） | 30 体の順位レース/価格/活動を**同時に一望**するのにブラウザのマルチパネルが向く |
| ライブ PnL / 順位 | **含める（RPC 断面読取）** | 「エージェントの強さをリアルタイムで見る」核心。`reconstruct` のロジックを現ブロックで再利用 |
| coordinator 改修 | **最小改修 OK** | run 開始時に agent registry を 1 行 emit する堅牢化のみ。評価パイプラインへの影響なし |

### 議論を踏まえた追加決定（2026-06-19）

実装に入る前の論点詰めで以下を決めた。

| 論点 | 決定 | 含意 |
|---|---|---|
| **初期スコープ** | ADR 通り **P0–P3 全パネル**を作る（MVP に削らない） | 順位/価格/tx フィード/活動グリッド/run 進捗まで一通り揃える |
| **観測干渉（poller の anvil 負荷）** | **まず作って実測で調整**（受入れ条件は必須化しない） | 「無害」と断定せず、thrash が出たら `DASH_POLL_EVERY` を伸ばす。ON/OFF での `round_timing` 比較は任意の検証手段として残す |
| **ライブ PnL の読取断面** | **`latest-1`（確定ブロック）を読む**。指標の権威は reconstruct、ライブは参考値と UI 明示 | 進行中ブロックの pending/未確定値を拾わず、確定採点とのズレを抑える |
| **対象 run スコープ** | **単一 run（`sim:realtime`）を対象**。複数 run 連続（discrimination）の自動追従は後回し | runWatcher は「固定 run dir / 起動時点の最新 dir」を見る。re-fork またぎの境界処理は当面スコープ外（後述） |

### 制約・前提（調査で確定した事実）

1. **PnL のライブ取得には anvil への RPC 読取が要る。** ファイル tail だけでは順位は出ない。
   → ダッシュボードは agent と**同じ読み方**（読取専用 Multicall3 断面）で anvil を叩く。
2. **必要な入力はすべてライブで揃う**：
   - agent アドレス → `agents/<id>.jsonl` の `direct_start` 行に既にある（無改修で取れる）。堅牢化のため registry emit も足す。
   - `priceFeed` アドレス → `events.jsonl` の `price_feed_deployed`。
   - `enabledProtocols` / `blockTimeSec` / `runBlocks` → `run_started_realtime`。
   - `activeStables` → enabledProtocols から導出（既存ロジック流用）。
3. **歴史深度の罠は無い。** ライブ読取は「現在ブロック」断面なので、~1,050 ブロックの保持深度上限
   （[[anvil-historical-state-depth-limit]]）に触れない。run 後再構成とは別の安全域。
4. **LLM 自己改善 agent の「判断理由(reason)」はライブには出ない。** `examples/agents/claude-llm.ts` は
   `createEmitter` を使わず stdout 直書きのため、`agents/<id>.jsonl` に来るのは directShim 経由の
   mempool イベント（`submitted/rejected/submit_failed`）と stderr のみ。reason のライブ表示は将来拡張（後述）。
5. **当面は単一 run を対象とする。** discrimination は run dir を次々作り、間に resetFork（full re-fork、
   数秒〜十数秒の過渡状態）を挟む。re-fork 中の anvil を poller が読むと壊れた値・run 境界の混線が起きるため、
   **複数 run 連続の自動追従は後回し**にし、まず `sim:realtime` の単発 run を対象にする（「決めていないこと」参照）。

## Decision

### 全体アーキテクチャ

coordinator（環境）/ agent プロセス群とは**完全に独立した第 3 のプロセス**としてダッシュボードを足す。
ADR 0006 の「環境とエージェント実行の分離」を崩さず、**観測者（observer）**を 1 つ追加するだけ。

```
┌─ coordinator（環境デーモン＝既存・ほぼ無改修）─┐   ┌─ agent プロセス × 30（既存・無改修）─┐
│  interval mining / fair price / flow / 採点    │   │  自分で署名・送信、jsonl 自己申告      │
└──────────────┬──────────────────────────────┘   └────────────┬──────────────────────┘
   runs/<id>/{events.jsonl, blocks.csv, agents/*.jsonl} を追記        │ 同じ anvil mempool
               │ (ファイル tail)                                       │
               ▼                                                       ▼
        ┌──────────────────────  dashboard プロセス（新規・読取専用）  ──────────────────┐
        │  runWatcher: 最新 run dir 追従 + 3 ファイルの増分 tail → 構造化イベント         │
        │  valuePoller: anvil に RPC 接続し N ブロックごとに価値断面を Multicall3 で読取    │
        │               （= reconstruct と同一の価値計算ロジックを現ブロックで実行）      │
        │  state:       ライブ状態を集約（順位 / 価格 / tx フィード / agent 活動 / run 進捗）│
        │  server:      HTTP(静的配信) + SSE(状態 push)                                    │
        └──────────────────────────────────┬──────────────────────────────────────────┘
                                            │ Server-Sent Events
                                            ▼
                              ブラウザ（マルチパネル UI・自動再接続）
```

**重要な性質**：ダッシュボードは anvil を**読むだけ**（`eth_call` / Multicall3）。tx は一切送らない。
したがって着順・fee 競争・採点に一切干渉しない（agent と同じ read-only 観測者）。

### データソース 2 系統

**(A) ファイル tail（runs/<id>/ を増分読取）** — 軽量・取りこぼしなし

| ファイル | ライブ内容 | ダッシュボードでの用途 |
|---|---|---|
| `events.jsonl` | `run_started_realtime` / `price_feed_deployed` / `round_timing`（毎ブロック）/ `tx_submitted` / `tx_submit_failed` / `run_completed` / `value_series_reconstructed` | run メタ・ブロック進行・処理レイテンシ・flow 活動・run 完了検知 |
| `blocks.csv` | 各 tx 行（`round,blockNumber,txIndex,from,priorityFeeWei,status,ownerId,role,actionType`） | tx フィード・着順・fee 競争・revert 率・ownerId 別活動 |
| `agents/<id>.jsonl` | `direct_start`(address) / `mempool: submitted/rejected/submit_failed` | agent アドレス取得・agent 別アクション率・採用/棄却ヒート |

**(B) RPC 断面読取（valuePoller）** — ライブ PnL / 順位 / 価格の源泉

- anvil（`ARB_RPC_URL` で起動中の同じ RPC）に `PublicClient` で接続。
- **N ブロックごと**（既定 `DASH_POLL_EVERY=2`、調整可）に、**確定ブロック（`latest - 1`）**を断面に取り、
  `reconstruct.ts` の**価値計算ロジックを 1 ブロック断面に対して実行** → 全 agent の総価値（spot + LP + aave + gmx）。
  進行中ブロックの pending/未確定 state を拾わないため `latest` ではなく `latest - 1` を読む。
- 同断面で `PriceFeed.latestAnswer()` と Uniswap `slot0`（pool tick→pool 価格）も取得。
- これにより **「採点と完全に同じ価値定義」のライブ順位**が出る（指標の一貫性）。
  ただし**ライブ値は参考値**であり、**指標の権威は run 後 reconstruct 側に置く**（間引き・確定ブロック読取で
  最終 discrimination と微小に乖離しうるため、UI 上でも「ライブ＝参考／確定＝reconstruct」を明示する）。

> 採点との一貫性のため、`reconstruct.ts` から **1 ブロック断面を読む純粋関数を抽出**して両者で共有する
> （下記「coordinator/reconstruct の最小改修」）。価値の二重定義を避けるのが狙い。

### coordinator / reconstruct の最小改修（許容範囲内）

1. **`reconstruct.ts` の関数抽出（挙動不変リファクタ）**
   現状 `reconstructValueSeries` は `fromBlock..toBlock` のループ内に断面読取が埋まっている。
   これを `readValueSnapshotAtBlock({ publicClient, agents, enabledIds, activeStables, priceFeed, blockNumber })`
   として切り出す。既存の run 後再構成ループはこの関数を呼ぶだけにする（**計算結果は完全に不変**）。
   valuePoller も同じ関数を呼ぶ → ライブと採点で価値計算が 1 本化。

2. **coordinator が run 開始時に agent registry を 1 行 emit**
   `run_started_realtime` の直後（agent アドレス確定後、`price_feed_deployed` 付近）に
   `{ type: "agents_registered", agents: [{ id, address, label }] }` を `events.jsonl` へ。
   `label` はロスターの id サフィックス（例 `si-codex-01-crossvenue` → kind=自己改善/base=crossvenue）を分類に使う。
   - direct_start からも address は取れるが、**registry emit があれば agent が 1 件も行動しなくても**
     ダッシュボードが全 agent を即座に把握できる（noop や起動直後の取りこぼしを塞ぐ）。
   - これ以外は coordinator に触れない。評価/採点パイプラインへの影響ゼロ。

### サーバ設計（`src/dashboard/`）

```
src/dashboard/
  server.ts        HTTP(静的配信) + SSE(/events) + 起動 env パース
  runWatcher.ts    runs/ の最新 dir 追従、3 ファイルの増分 tail、行→構造化イベント
  valuePoller.ts   anvil RPC ポーラー（readValueSnapshotAtBlock 呼び出し + PriceFeed + slot0）
  state.ts         ライブ状態モデル（順位/価格履歴/tx リング/agent 集計/run メタ）と差分生成
  labels.ts        roster id → {kind: si|frozen|baseline, base, offset} 分類
  public/
    index.html     パネルレイアウト（CSS グリッド）
    app.js         SSE 購読・状態適用・再接続
    charts.js      軽量チャート（uPlot もしくは canvas 自前。依存最小を優先）
```

- **技術スタック**：サーバは既存と同じ Node/tsx + viem（新規依存ほぼなし）。
  push は **SSE**（WebSocket より単純で、ダッシュボードは一方向 push で足りる）。
  フロントは**フレームワークなし**の単一 HTML + ESM。チャートのみ軽量ライブラリ（uPlot 等）を検討。
- **起動**：`npm run dashboard`（`package.json` に `"dashboard": "tsx src/dashboard/server.ts"`）。
  env: `DASH_PORT`(既定 4317) / `DASH_POLL_EVERY`(既定 2 ブロック) / `RUNS_DIR`(既定 `runs`) / `RUN_DIR`（対象 run を明示指定。未指定なら起動時点の最新 dir）/ `ARB_RPC_URL`（anvil RPC、未設定なら RPC 読取を無効化しファイル tail のみで動く degrade モード）。
- **対象 run（単一 run 前提）**：`runWatcher` は `RUN_DIR`（明示指定）または起動時点の最新 run dir を対象に固定する。
  `run_completed` を見たら poller を止め、`value_series_reconstructed` 後の確定値に切替表示する。
  **複数 run の連続追従（次 run への自動切替・re-fork 中の poller 退避）はスコープ外**（「決めていないこと」）。

### SSE メッセージ契約（サーバ → ブラウザ）

| event | payload | 発火 |
|---|---|---|
| `snapshot` | 現在のフル状態 | クライアント接続時 |
| `run` | `{ phase: started\|completed, runId, enabledProtocols, blockTimeSec, runBlocks }` | run ライフサイクル（単一 run。`switched`/regime・replication は複数 run 対応時に拡張） |
| `block` | `{ blockNumber, ts, timingMs, fairPrice, poolPrice }` | 毎ブロック（round_timing + poller） |
| `values` | `{ blockNumber, ranking: [{ id, valueUsdc, pnlUsdc, rank }] }` | N ブロックごと（poller） |
| `tx` | `{ blockNumber, txIndex, ownerId, role, actionType, priorityFeeWei, status }` | blocks.csv 新行 |
| `agentAction` | `{ agentId, event: submitted\|rejected\|submit_failed, actionType, reason? }` | agents/*.jsonl 新行 |

### フロントエンド・パネル構成

1. **順位レース（主役）** — ライブ PnL の横棒/ラインレース。kind（si/frozen/baseline）で色分け。`values` 駆動。
2. **価格チャート** — fair price と各 venue pool 価格の乖離（裁定機会の可視化）。`block` 駆動。
3. **ブロック進行 / レイテンシ** — blockNumber 進捗、`round_timing` の処理 ms（thrash 検知）。
4. **tx フィード** — 最新 tx を流す。revert を赤、fee と着順を表示。flow/agent を区別。
5. **agent 活動グリッド** — 30 体を格子表示。各セルに採用率（submitted / (submitted+rejected)）と直近アクション。
6. **run 進捗** — regime×replication のどこを実行中か、enabled protocols、block time。
7. **(将来) LLM revise トラッカー** — 各自己改善 agent の version 採用履歴（stderr / summary `stderrTail`）。

### 実装フェーズ（設計時点の見積り。本 ADR では実装しない）

- **P0 基盤**：`readValueSnapshotAtBlock` 抽出（挙動不変）＋ coordinator の `agents_registered` emit。`npm run dashboard` の骨組み。
- **P1 データ取り込み**：runWatcher（最新 run 追従 + 3 ファイル tail）＋ valuePoller（RPC 断面）＋ state 集約＋ SSE。
- **P2 フロント**：index.html + SSE 購読 + 順位レース/価格/tx フィード/活動グリッド。
- **P3 仕上げ**：run 完了時の確定値切替、LLM revise トラッカー、degrade モード。（複数 run の連続追従はスコープ外）

## Consequences

**得られるもの**
- mixed30 を単発 run（`sim:realtime`）で回しながら、順位レース・価格乖離・thrash・各 agent の適応をライブで観測できる（複数 run 連続の discrimination 追従は後続）。
- 価値計算が採点（reconstruct）とライブで 1 本化され、「画面の順位」と「最終 discrimination」が整合する。
- 読取専用・別プロセスのため**着順・fee 競争・mempool には干渉しない**（tx を送らない）。
  ただし RPC 読取は anvil の CPU を使うため、**実行レイテンシ経由の間接的な影響は実測で確認する**（下記リスク）。

**コスト・リスク**
- **RPC 読取が run 結果を歪めうる（観測の干渉）**：anvil は実質シングルスレッドで EVM を逐次実行し、
  `eth_call`/Multicall3 も CPU を食う。mixed30 + codex 18 並走は既に CPU 律速（[[parallel-selfimprove-agents]]、
  8 コアで ~36 体が上限）。poller の読取が mining/実行と CPU を食い合い、**2.0s/block の維持や agent の
  行動 runway を間接的に削る**恐れがある（= 観測が対象を歪める）。着順自体は read-only なので不変だが、実行遅延経由で効きうる。
  **方針（議論で決定）：まず作って実測で調整する。** 受入れ条件は必須化しない。1 ブロック断面は run 後再構成の
  実測（279 block で 3.4s ＝ ~12ms/断面）から十分軽い見込みだが、thrash の兆候が出たら `DASH_POLL_EVERY` を
  伸ばす／RPC 読取を無効化（ファイル tail のみの degrade）。検証したい場合は**ダッシュボード ON/OFF で
  `round_timing` を比較**して実害を測れる（任意）。
- **採点リファクタの慎重さ**：`reconstruct.ts` の関数抽出は採点ロジックに触れる。
  **計算不変**を厳守し、既存 run の再構成結果と数値一致をテストで担保してからマージ。
- **LLM reason のライブ欠落**：当面は mempool 行動＋stderr で代替。reason をライブ表示したいなら
  `claude-llm.ts` を `createEmitter` 経由に寄せる別変更が要る（本 ADR スコープ外）。
- **`ARB_RPC_URL` 前提**：clean な比較評価は `ARB_RPC_URL` 必須（[[env-alpha-dominance-achieved]] /
  [[anvil-reset-does-not-clear-state]]）。ダッシュボードも同じ RPC を読むため、運用手順に合致。

## 決めていないこと（スコープ外）

本 ADR は「**ライブ観測基盤**」に集中し、以下は意図的に先送りする。先送りが意図的であることを明示する。

| 項目 | 決めない理由 | いつ決めるか |
|---|---|---|
| **複数 run 連続（discrimination）の自動追従** | run 間の re-fork（数秒〜十数秒の過渡状態）中に poller が壊れた anvil を読む／run 境界が混線するため、堅牢な境界処理（イベント駆動の poller 退避・次 run 自動切替）が要る。まず単一 run で価値を出す | discrimination をダッシュボードで観測したい需要が固まったら（イベント駆動 poller 退避を設計） |
| **LLM 判断理由(reason) のライブ表示** | `claude-llm.ts` が `createEmitter` 未使用で stdout 直書きのため、reason をライブ表示するには agent 側の別変更が要る。本 ADR は観測基盤に集中する | reason のライブ表示需要が出たら（`claude-llm` の `createEmitter` 化を別 ADR で） |
| **チャートライブラリの選定**（uPlot / canvas 自前 / 他） | 「依存最小」という方針だけ確定。具体ライブラリは描画要件（系列数・更新頻度）が固まってから決めるのが妥当 | P2 フロント実装時 |
| **複数マシン分散での観測** | 現状 8 コア単機で mixed30 が回る（[[parallel-selfimprove-agents]]）。分散は coordinator が 1 anvil 前提なので別設計が要る | 大型機／複数マシン分散実行が必要になったら |
| **過去 run の事後ブラウズ／比較 UI** | 本 ADR の核心はライブ観測。確定値の比較は既存の `discrimination.md` / JSON / `gate` で足りる | 事後分析を画面で行いたい需要が出たら |
| **認証・アクセス制御** | ローカル開発前提（localhost バインド）でリスクが低い | ダッシュボードを外部公開する運用が出たら |

## Alternatives considered

- **ターミナル TUI**：ssh 越し・軽量だが、30 体の順位レース＋価格＋tx を同時に追うには情報密度が足りず却下。
- **静的 HTML 自動生成**：サーバ不要だが、リアルタイム性が更新間隔依存で核心要求（ライブ順位）に弱く却下。
- **coordinator にライブ価値スナップショットを内蔵**：採点ループに観測責務を混ぜると ADR 0006 の分離が濁る。
  観測は独立プロセスに切り出す方が筋が良いと判断（最小改修は registry emit のみに留める）。
- **ファイル tail だけで PnL 代理**：tx 活動量は PnL の代理にならない（β 由来の含み益が見えない）。
  ライブ順位の核心を満たせず却下。代わりに RPC 断面を採用。
```
