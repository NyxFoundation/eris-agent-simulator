[← 目次](README.md) ｜ [← 07 設定](07-configuration.md) ｜ [09 ダッシュボード →](09-dashboard.md)

# 08. 成果物（データ契約）

出典 `core/src/logger.ts`（書き出し）、`core/src/realtime/{reconstruct,marketSeries,liveScoring}.ts`（内容）、`core/src/manifest.ts`、`core/src/segments.ts`、`core/src/backtest/standings.ts`。

## 8.1 ディレクトリ構成

```
runs/
  <runId>/                          単一 run（runId = ISO 時刻文字列）
    summary.json                    集計と採点
    events.jsonl                    全イベントの時系列
    blocks.csv                      ブロック内 tx の記録
    market.json                     venue 状態の系列（報告専用）
    manifest.json                   環境マニフェスト
    epochs.jsonl                    エポック境界（live 採点。逐次追記）
    market.jsonl                    venue 状態（live サンプル。逐次追記）
    agents/<id>.jsonl               エージェントの自己申告ログ
    agents/<id>.llm.jsonl           改訂の生のやり取り（opt-in）

  <competitionId>/                  セグメント run（run.segmentHours > 0）
    matrix.json                     セグメント索引
    <日付>-s<NN>/                    各セグメント = 通常の run ディレクトリ

  matrix-<id>/                      シナリオ行列
    matrix.json                     シナリオ × エージェントの生スコア
    standings.json                  順位（派生物）
    <各シナリオの run ディレクトリ>
```

**セグメントもシナリオも「通常の run ディレクトリ」**であり、既存のツールがそのまま読める。`matrix.json` という名前と形も共通（ダッシュボードが同じコードで読むため）。

## 8.2 `summary.json`

| フィールド | 内容 |
|---|---|
| `runId` | run 識別子 |
| `mode` | `"realtime"` / `"backtest"`（どの入口から来たか） |
| `resetUnit` | `"continuous"` / `"scenario"`（[02 §2.4](02-runtime.md)） |
| `blockTimeSec` / `blocksProcessed` / `elapsedMs` | 実行の実測 |
| `finalFairPriceUsdcPerWeth` | 最終 fair price |
| `valueSeries` | 価値系列のメタ（下記） |
| `epochScores[<id>]` | エージェントごとの採点結果（下記） |
| `violations` | 事後ルール検査の違反 |
| `agents[]` | エージェントごとの集計（下記） |
| `segment` / `fromBlock` / `toBlock` | セグメント run のみ |

### `agents[]`

| フィールド | 内容 |
|---|---|
| `id` / `address` | |
| `initialValueUsdc` / `finalValueUsdc` | run 開始 / 終了時の総価値（venue ポジションの評価を含む） |
| `netPnlUsdc` | `finalValueUsdc − initialValueUsdc` |
| `alphaUsdc` | β 除去 PnL（**スキル比較はこちら**）。再構成が走らなかった run では欠落 |
| `markedValueUsdc` | **額面**。採点値（回収可能額）と食い違ったエージェントにのみ付く。issue #40 公理 3 以降、採点は回収可能額なので、これは「使われなかったほうの数字」 |
| `processExitedEarly` | プロセスが run 終了前に消えた理由。**シナリオ行列はこれを読んで失格にする** |
| `includedTxCount` / `revertCount` | 取り込まれた tx 数 / うち revert した数 |
| `stderrTail` | エージェントプロセスの stderr 末尾（クラッシュ診断用） |

**初期値と最終値は同じ価格で評価する**（最終ブロックの fair prices と stable prices）。`netPnlUsdc` は差分なので、両端を別のマークで評価するとペグの歴史全体がそのエージェントの PnL として記帳されてしまう。

### `valueSeries`

| フィールド | 内容 |
|---|---|
| `source` | `"post-run-reconstruction"` / `"live-epoch-boundaries"` / `"live-observation"` |
| `granularityBlocks` / `fromBlock` / `toBlock` / `blocks` / `windowBlocks` | 読み取り範囲 |
| `failedReads` / `failedReadTargets` | 読めなかった横断面の数と、**どのコントラクトのどの関数か** |
| `alphaRefFairUsdcPerWeth` / `alphaByAgent` | α の固定参照とその値 |
| `markedValueByAgent` | 額面。採点値と差が出たエージェントのみ |
| `unpricedHoldings` | 値付けできなかった / 読めなかった / 換金不能 / par 仮置きの保有（[06 §6.2](06-scoring.md)） |
| `epochSeries` | **採点の元になる境界値**（下記） |
| `epochSeriesMeta` | live 採点のメタ（`boundaries` / `failedBoundaries` / `epochBlocks` / `markMedianBlocks`） |
| `markMedian` | G7 の適用結果（`windowBlocks` / `boundaries` / `surfaces` / `maxDeviationBps`） |
| `failed` / `error` | 再構成が失敗したとき |

`epochSeries`：

```json
{ "epochBlocks": 12, "epochs": 29,
  "boundaryBlocks": [1001, 1013, ...],
  "valuesByAgent": { "venue-arb": [25000.0, 25003.4, null, ...] } }
```

**`null` は「その境界でこのエージェントが報告しなかった」であって 0 ではない。**

**両方の系列が存在する run では live 側が権威になる**（`summary.json` のラウンドとスコアが同じオブジェクトを指すように）。sweep も走った run では `valueSeries.source` は sweep のままで、live のメタは `epochSeriesMeta` に**ネストして**入る（spread するとその run が「sweep していない」と名乗ることになる）。

### `epochScores[<id>]`

| フィールド | 内容 |
|---|---|
| `score` | `mean − λ·std` |
| `meanLogReturn` / `stdLogReturn` | 内訳 |
| `logReturns` | 実際に採点した E 個のリターン（フロア・凍結・持ち越し適用後） |
| `bankruptAtEpoch` | フロアに最初に触れたエポック（1-based）。`null` なら破産していない |
| `carriedForwardEpochs` | 値が欠けて持ち越したエポック（**環境の失敗であってエージェントの失敗ではない**ので明示する） |
| `floorUsdc` / `lambda` | 適用したパラメータ |
| `benchmarkApplied` | **false なら生収益**。超過収益として読んではいけない |

## 8.3 `events.jsonl`

1 行 1 イベント。全行に `ts`（ISO 時刻）が付く。以下は coordinator が emit する型のカタログ（venue モジュールが出すものを含む）。

### run のライフサイクル

| type | 内容 |
|---|---|
| `run_started_realtime` | run の開始。**seed / flowSeed / epochBlocks / rpcUrl / chainId / chainMode を含む**。セグメント時は各セグメント冒頭にも出る |
| `run_completed` | 完了 |
| `deployment_check` | デプロイの実測（chainId / checked / missing） |
| `agents_registered` | ロスター全体（id / address / baseline / description / external） |
| `agent_external_registered` | 外部参加者の登録（環境は起動しない） |
| `agent_process_exited` | エージェントプロセスの異常終了 |
| `initial_endowment` | 各エージェントの初期価値と最大/最小比 |
| `price_feed_deployed` / `flash_arb_deployed` | |
| `interval_mining_started` / `fork_reset_skipped` / `prewarm_completed` | |
| `external_chain_block_time` / `external_chain_mint_guard` / `treasury_funded_roles` | external モード |
| `economic_gas_enabled` / `fee_cap_enforcement_disabled` | economicGas プロファイル |
| `realtime_block_error` | ブロック処理中の例外（ループは継続） |
| `round_timing` | 各段の所要時間（`keeperMs` / `oracleMs` / `stateFlowMs` / `epochMs` / `blocksMs` / `totalMs` …） |

### 採点

| type | 内容 |
|---|---|
| `epoch_boundary` | 境界の値（`epochs.jsonl` と同じ内容） |
| `epoch_boundary_failed` | 境界が読めなかった |
| `epoch_series_scored` | スコア算出のメタ |
| `epoch_series_agreement` | **live と sweep の一致検査**（`compared` / `maxAbsDiffUsdc` / `maxRelDiff` / `worst`） |
| `value_series_reconstructed` / `value_series_reconstruction_failed` | 事後 sweep |
| `post_run_sweep_skipped` | 窓が履歴保持深度を超えたので**明示的にスキップ**した |
| `market_series_reconstructed` / `market_series_reconstruction_failed` | market.json |
| `rule_violations_detected` | 事後ルール検査 |

### ストレス / venue

[04 §4.10](04-stress-events.md) の一覧。加えて：

| type | 内容 |
|---|---|
| `lst_block` | 毎ブロックの LST 状態（償還レート / 市場価格 / discount / reward reserve） |
| `liquity_block` | 毎ブロックの Liquity 状態（peg / TCR / 手数料 / 最下位 ICR） |
| `lst_setup` / `liquity_setup` | 起動時の検証結果 |
| `no_arb_startup` / `no_arb_persistent_warning` | 無裁定チェック |
| `keeper_failed` / `oracle_update_failed` / `lst_accrual_failed` / `liquity_watch_failed` / `vuln_watch_failed` / `vuln_fund_failed` | 各タスクの失敗 |
| `tx_submitted` / `tx_submit_failed` | 環境が送信した tx |

**`lst_block` / `liquity_block` を毎ブロック出しているので、ダッシュボードはそこから venue の状態を再構成できる**（`market.json` に依存しない = 古い run でも描ける）。

## 8.4 `blocks.csv`

列は `core/src/logger.ts:8` の `BLOCKS_CSV_COLUMNS` が単一の出典。

| 列 | 内容 |
|---|---|
| `round` | ブロック番号（= `blockNumber`） |
| `blockNumber` | |
| `txIndex` | ブロック内の位置。**0 が最先頭** |
| `hash` / `from` | |
| `priorityFeeWei` | **オンチェーンの tx フィールド由来**（自己申告ではない = 事後検査の根拠） |
| `status` | `success` / それ以外（receipt 取得失敗時は `mined`） |
| `ownerId` / `role` | 帰属（`agent` / `uninformed-flow` / `informed-flow` / `system`） |
| `actionType` | **環境が送信した tx にのみ存在する**（送信者の意図）。エージェントの tx は `direct` |
| `bundleId` / `bundleIndex` | バンドル |
| `method` | **calldata からデコードした関数名**（`sdk/src/methodSelectors.ts`） |

**`method` が `actionType` と別に要る理由**（ADR 0021 §4）：`actionType` は環境が送った tx にしか無い。エージェントのログを join する方式は coordinator がエージェントを起動している間しか成立せず、外部参加者の tx が全部 `direct` になる＝**トラフィックが最も多いところで最も情報が無い**。calldata デコードは全 tx に効く。

帰属は **from アドレスの引き当て**が一次で、`submittedByHash` は環境が送った tx の `actionType` / fee を補うためだけに使う。

書き出しのタイミング：

- 通常 run：終了時に一括スキャン。**途中でクラッシュすると blocks.csv は空**（診断は events.jsonl）
- セグメント run：毎ブロック `bn−1` まで追いつく。一括パスは「終わりのある run」でしか成立せず、終わりの無い期間では**全セグメントの blocks.csv が空になる**（実測）

## 8.5 `market.json`（報告専用）

**採点には一切使わない。** 事後の歴史読み取りで作るのでライブループのコストは 0。

| フィールド | 内容 |
|---|---|
| `source` / `fromBlock` / `toBlock` / `granularityBlocks` / `rows` | メタ |
| `failedReads` / `failedReadTargets` / `elapsedMs` | |
| `bases` / `venues` | |
| `series[]` | 下記 |
| `gmxPositionsAtEnd` / `aaveAccountsAtEnd` / `lstPositionsAtEnd` / `liquityPositionsAtEnd` | **run 最終ブロックの建玉断面** |
| `notionals` | tx hash → デコードした USD notional |
| `notionalsMeta` | `txsSeen` / `decoded` / `receiptFailures` / `unknownTokenTransfers` |

`series[]` の 1 行：

| フィールド | 内容 |
|---|---|
| `block` | |
| `fair` | base → USD（オンチェーン PriceFeed の値） |
| `venues` | venue → base → `{mid, buy, sell, depthUsd}` |
| `gmx` | base → `{longOiUsd, shortOiUsd, fundingPerHourBps?}`。**読み取り失敗時は省略**（0.00bps と表示させない） |
| `aave` | 資産 → `{suppliedUsd, borrowedUsd, utilization}` |
| `stables` | symbol → `{priceUsdc, sellPriceUsdc, buyPriceUsdc, quoted}` |

**`stables[].quoted: false` は「プールが quote を拒否したので par にフォールバックした」**であり、ここで唯一「ペグが保たれた」と読んではいけない数値。

**建玉断面が全 venue 分ある理由**：以前は GMX だけを見ていたので、run 中ずっとステークや借入だけしていたエージェントは空表になり「壊れている」と見分けがつかなかった。

## 8.6 `agents/<id>.jsonl`

エージェント自身が書く。2 種類の行が混在する。

| 種別 | 内容 |
|---|---|
| 判断ログ（`ctx.log`） | `round` / `action` / `reason` / `signals` / `sizing` / `expectedPnlUsdc` / `state` |
| mempool 活動（`kind: "mempool"`、send.ts が追記） | `event: submitted` / `submit_failed` / `rejected` / `bad_action` / `approval_failed` / `approvals_granted` / `runtime_start` |

**自己申告が必要な理由**：direct 送信では coordinator が「提出されたが取り込まれなかった tx」を数えられない（ADR 0006 §5）。

自己改善エージェントの改訂結果はここに `reason: "revision <kind>"` + `state` として残る。生のやり取りは `ERIS_IMPROVE_LOG_CALLS=1` で `agents/<id>.llm.jsonl` へ（opt-in。全生成戦略が丸ごと入るため既定 off）。

**外部参加者の判断ログは参加者のマシンにしか無い。**

## 8.7 `epochs.jsonl` / `market.jsonl`（live 追記）

`events.jsonl` とは別ファイルにしてある。**独立に tail できることが、1 週間分のイベントを読まずにライブ順位を出せる条件**（ADR 0021 §3）。

`epochs.jsonl` の 1 行 = `{index, blockNumber, fairPriceUsdcPerWeth, values: {agentId: number|null}, elapsedMs}`。

`market.jsonl` は `market.json` の `series[]` と同じ行形式を境界ごとにサンプルしたもの（毎ブロックではない — 1 週間分の venue 行は誰も開けないファイルになる）。

## 8.8 `manifest.json`（環境マニフェスト）

自己ホスト参加者へ配る唯一の資料（ADR 0021 §2）。`buildManifest`（`core/src/manifest.ts:109`）。

| セクション | 内容 |
|---|---|
| `schema` / `generatedAt` | `eris-environment-manifest/1` |
| `status` | `{scored: false, label: "practice", note}` — **順位の出自が順位と別々に流通しないよう文書自体に書く** |
| `chain` | `rpcUrl` / `readRpcUrl` / `chainId` / `chainMode` / `blockTimeSec` |
| `round` | `epochBlocks` / `approxSeconds` / `markMedianBlocks` / `scoreEvery`（ブロックと分の**両方**を出す） |
| `protocols` / `actions` | 有効な venue と、その venue のアクション語彙 |
| `contracts` | **有効な venue のアドレスのみ** + `priceFeed` + `stableMarkets` |
| `tokens` | symbol → `{address, decimals, kind}` |
| `limits` / `funding` | 上限と配布額 |
| `episodes` | **種類と件数だけ**（`{type, count}[]`） |
| `participants` | id / address / external / baseline / description |

**2 つの規則**（`manifest.ts:9-19`）：

1. **秘密情報は入らない。** coordinator が run ディレクトリに書き、ダッシュボードがそれを HTTP で配る。ここに秘密鍵を入れることは公開することを意味する。個別の鍵は `npm run manifest -- --participant <id>` が **stdout にだけ**出す
2. **ストレスの窓は入らない。** 種類と件数は公開し、いつ開くかは伏せる。**resolved schedule ではなく config のイベント列から作る**ので、将来 schedule にフィールドが増えても構造的に漏れない

## 8.9 `matrix.json` / `standings.json`

### シナリオ行列（`npm run backtest -- --scenarios`）

`matrix.json` はシナリオ × エージェントの**生スコア（4 指標すべて）**と、それを計算した 2 つの断面（`initialValueUsdc` / `finalValueUsdc`）を持つ。断面を持つ理由：**run ディレクトリは残らない**（2026-08-09 の 30 run のうち 5 本は既に失っていた）。差分しか保存していないと、規則を変えたときに再計算できない。

`runDir` は**相対パス**なので、spot から回収した tarball を展開したディレクトリでもそのまま読める。

`standings.json` は**派生物**：`matrix.json` から `computeStandings` で再計算できる。順位の規則は将来見直す前提（ADR 0017 §4）。

| `standings.json` | 内容 |
|---|---|
| `metric` | どの指標で順位付けしたか |
| `agents[]` | `id` / `total` / `byRegime` / `scenariosScored` / `disqualifications` |
| `regimes` | レジーム順（行列を走らせた順） |
| `scenarios[]` | シナリオごとの `scores` / `z` / `disqualified` |
| `excludedScenarios[]` | **summary が無かったシナリオ**（環境の失敗なので参加者に負わせない） |

### セグメント索引（`core/src/segments.ts`）

セグメント run も同じ `matrix.json` を書く。エントリは**standings 形**（ダッシュボードが同じコードで読むため）。

| フィールド | 内容 |
|---|---|
| `schema` / `createdAt` / `scenarioSet` | |
| `resetUnit` | **正直に `"continuous"`**（1 つの world を切ったものであって別々の world ではない） |
| `segmentHours` / `scenariosPlanned` | |
| `scenarios[]` | `{regime: "segment", seed: <番号>, label: <日付>, runDir, fromBlock, toBlock, startedAt, endedAt, agents[]}` |

セグメントの `agents[]` の `alphaUsdc` は **0 として報告する**（α は固定参照の sweep を要し、連続チェーンのセグメントはそれを得られない）。省略ではなく 0 なのは、standings がそのフィールドを読むため。

索引は変更のたびに**全体を書き直す**（追記ではない）。半分書けた日付リストは、1 日遅れているリストより悪い。

## 8.10 成果物の大きさ

実測（5 venue・3 エージェント・400 ブロック run）：

| ファイル | 1 ブロックあたり |
|---|---|
| `events.jsonl` | 約 1,437 B |
| `blocks.csv` | 約 731 B |

1 週間を非分割で走らせると `events.jsonl` 435MB・`blocks.csv` 221MB・336 ラウンドが 1 本のバーになる。**20,000 ブロック（2 秒 cadence で約 11 時間）を超える非分割 run は起動時に警告する**（[02 §2.1](02-runtime.md)）。
