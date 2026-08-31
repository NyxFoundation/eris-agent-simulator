[← 目次](README.md)

# 00. 概要とスコープ

## 0.1 定義

**Eris Agent Simulator** は、全 DeFi プロトコルをデプロイした 1 本のチェーン上で、複数の自律エージェントを同一 mempool 内で競争させ、その結果をリスク調整済みスコアで採点するシミュレータである。

構成要素は 3 つに分かれる。

| | 責務 |
|---|---|
| **環境（environment）** | チェーンのライフサイクル、fair price の生成と配信、orderflow、keeper、ストレスイベントの注入 |
| **エージェント（agent）** | 確定済み状態の観測 → 判断 → 署名・送信。環境とは独立した OS プロセス |
| **採点（scoring）** | エポック境界での価値横断面の読み取りと、そこからのスコア算出 |

環境と採点は同一プロセス（coordinator）に同居するが、エージェントとは**チェーン以外で接点を持たない**。

## 0.2 スコープ

### 含むもの

- 7 venue のオンチェーン市場（Uniswap V3 / Balancer v2 / Curve / Aave v3 / GMX v2 / LST vault / Liquity V1 フォーク）
- seed 決定論の fair price 生成と、その全 venue への伝播
- 9 種のストレスイベント（価格ギャップ・大口・板の薄化・デペグ・slash・ドリフト・フロー傾斜）
- エージェント実行ランタイム（ルール型 / 自走型 / 自己改善型の 3 契約）
- エポック単位のリスク調整採点と、シナリオ行列に対する集約
- run 成果物（`runs/<id>/`）と、それを描画する web UI
- 練習 devnet 運用（外部参加者の登録、環境マニフェスト、日次セグメント）

### 含まないもの

- **本番の競技運営そのもの** — 提出・審査・賞金は [競技規約](../competition-rules.md) の管轄で、本システムは実行基盤のみを提供する
- **実市場との対応の保証** — オラクルはモック、fair price は合成パス（[README Disclaimer](../../README.md)）
- **エージェントの戦略** — `example/agents/` は参照実装であって仕様ではない
- **チェーンクライアントの実装** — anvil または外部 OP Stack devnet を前提とする

## 0.3 実行形態

同一の coordinator（`core/src/realtime/coordinator.ts:390` `runRealtimeSimulation`）を、4 通りの入口から使う。

| 形態 | 入口 | world の数 | `resetUnit` |
|---|---|---|---|
| 実時間 run | `npm run sim:realtime` | 1（開始から終了まで 1 つ） | `continuous` |
| シナリオ 1 本の再生 | `npm run backtest -- --regime <名> --seed <N>` | 1 | `continuous` |
| **シナリオ行列** | `npm run backtest -- --scenarios <path>` | (regime, seed) ごとに 1 | **`scenario`** |
| 練習 devnet | `npm run sim:realtime`（`chainMode: external`） | 1（止まらないチェーン、出力のみ日次分割） | `continuous` |

**`resetUnit: scenario` を宣言できるのはシナリオ行列ランナーだけ**で、config ファイルに書いて `sim:realtime` を起動すると fail-fast する（`coordinator.ts:405`）。1 つの world を「多数」と名乗る `summary.json` は、後から検出できない嘘になるため。

## 0.4 中心概念とデータの流れ

```
                 seed
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
  fair price 系列      ストレススケジュール
   (OU プロセス)         (窓の位置・大きさ)
        │                    │
        └────────┬───────────┘
                 ▼
        effective price ──► PriceFeed / 各 venue のオラクル
                 │                    │
                 │                    ▼ (1 ブロック遅延)
                 │            ┌──────────────┐
                 └──flow bot─►│    chain     │◄── agent tx（署名・直接送信）
                              │  1 mempool   │
                              │ --order fees │
                              └──────┬───────┘
                                     │ 確定ブロック
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              observation      epoch 境界の      blocks.csv /
              （agent が再構成）   価値横断面      events.jsonl
                                     │
                                     ▼
                            score = mean − λ·std
```

| 概念 | 定義 | 出典 |
|---|---|---|
| **run** | 1 回の実行。`runs/<runId>/` を 1 つ（セグメント時は複数）生成する | `coordinator.ts:491` |
| **ブロック** | 環境の時間の最小単位。既定 2 秒（`run.blockTimeSec`） | `sdk/src/config.ts:351` |
| **エポック（ラウンド）** | 採点の単位。既定 12 ブロック（`run.epochBlocks`）。実時間で書くこともできる（`run.epochSeconds`） | `sdk/src/config.ts:590` |
| **シナリオ** | (regime, seed) の組。1 本の市場の再生 | ADR 0017 §1 |
| **regime** | 市場条件の型。`config/regimes/<name>.yaml` が価格・フロー・イベントの生成規則を持つ | `config/regimes/` |
| **fair price** | 環境が生成し PriceFeed 経由で全員に配る基準価格 | `core/src/realtime/priceFeed.ts` |
| **observation** | 確定済み状態から再構成される、エージェントへの唯一の入力 | `sdk/src/types.ts:634` |
| **action** | エージェントが返す取引意図。25 種の leaf + 制御 4 種 | `sdk/src/types.ts:332` |
| **benchmark** | ロスターの `baseline: true` エントリ。スコアはこれに対する超過 | `core/src/scoring/epochScore.ts:36` |
| **venue** | 1 つのプロトコル実装。`sdk/src/protocols/<id>.ts` のアダプタが表現する | `sdk/src/protocols/registry.ts` |

## 0.5 設計原則

実装全体を貫く 6 つ。各章はこれらの具体化である。

### P1. 環境とエージェントはチェーン以外で接点を持たない

エージェントに渡されるのは RPC URL・自分の秘密鍵・PriceFeed アドレス・run ディレクトリだけで、**他人の鍵・pending tx・txpool は渡らない**（`core/src/realtime/agentProcess.ts:40-63`）。mempool を覗く front-run が構造的に成立せず、全員が同じ情報と同じ mempool で競う。→ [01](01-architecture.md)

### P2. 観測は確定済み状態のみ、情報は 1 ブロック遅れる

fair price はオンチェーンに書かれ、その書き込み tx は次ブロックで着弾する。よって**全員に等しく 1 ブロックの遅延がかかる**（`docs/guide/architecture.md:49`）。これは制約ではなく仕様であり、清算の検知遅延（観測 1 + mempool 1 = 2 ブロック）もここから導かれる。

### P3. seed は市場条件のラベルであって、結果の再現ではない

価格パスとイベント窓は seed の純関数で再現する。しかし **tx のタイミングと着順は非決定**なので、同一 seed でも結果はぶれる（ADR 0005）。run 単体の比較には意味がなく、比較にはサンプルの蓄積が要る。

### P4. 黙って落とさない（fail-fast と明示的な報告）

較正が崩れた状態、存在しない venue を指すイベント、鍵の衝突、デプロイの不在は**起動時に落とす**。実行中に読めなかった横断面は 0 で埋めずに `null` を残し、値付けできなかった保有は `unpricedHoldings` に報告する。→ [11](11-invariants.md)

### P5. 採点の材料をすべて保存し、スコアは派生物とする

`summary.json` にはスコアだけでなく、それを計算したエポック系列そのものが入る。`npm run metrics` は run を再実行せずに別の指標で採点し直せる。順位も `matrix.json` からの派生物であり、採点方法は将来見直す前提（ADR 0017 §4）。→ [06](06-scoring.md)

### P6. 設定は YAML 一本、秘密情報だけが env

run のノブとロスターは `config/local.yaml` に集約する。env に残るのは**秘密情報（鍵・RPC・API キー）・エージェント IPC・設定ファイル選択**の 3 分類のみ（`sdk/src/runConfig.ts:21`）。退役した config env が設定されていると警告する（`core/src/runConfig.ts:110`）。→ [07](07-configuration.md)

## 0.6 用語

| 用語 | 意味 |
|---|---|
| coordinator | 環境デーモン兼採点者。`core/src/realtime/coordinator.ts` |
| adapter | protocol アダプタ。1 venue = 1 実装。`sdk/src/protocols/*.ts` |
| roster | ロスター。この run に参加するエージェントの一覧（config の `agents:`） |
| flow bot | 環境側の市場機構。独立プロセスとして注文を生成し市場を動かす |
| keeper | GMX の注文執行者。coordinator が毎ブロック動かす |
| victim | 清算を成立させるために環境が建てる、採点対象外のポジション |
| overlay | ストレスイベントによる価格の乗算的な歪み。base price には触れない |
| base / stable / lst | トークンの種別。値付けの経路が 3 つに分かれる（`sdk/src/types.ts:13`） |
| α（alphaUsdc） | β を除去した PnL。約定時の fair 価格を基準に測る |
| β | 価格ドリフト由来の損益。保有しているだけで動く分 |
| M9 | 現行の競技スコア `mean − λ·std`（ADR 0019） |
| G1 / G2 | 破産フロア（初期資本の 1%）と、それ以降の系列凍結 |
| segment | 止まらないチェーンの出力を時間で切った単位。チェーンは連続のまま |
| external agent | 参加者が自分のマシンで動かす登録済みエージェント。環境は起動しない |

## 0.7 この仕様書が扱わない実装詳細

以下は本書では扱わず、コードとその周辺文書を直接の出典とする。

- 各 venue の内部実装（Liquity V1 core は**無改変フォーク**であり、その仕様は上流のもの）
- `deployer/` のデプロイ手順詳細 → `deployer/README.md`、[10 運用](10-operations.md) から参照
- 各参照エージェントの戦略ロジック（`example/agents/<id>/agent.ts`）
- 較正値の測定記録 → [`docs/scoring-metric-measurements.md`](../scoring-metric-measurements.md)
