[← 目次](README.md) ｜ [← 01 システム構成](01-architecture.md) ｜ [03 市場環境 →](03-market.md)

# 02. 実行モデル

出典は `core/src/realtime/coordinator.ts`（`runRealtimeSimulation`、L390–2761）。行番号は同ファイル。

## 2.1 run のライフサイクル

```
[A] 設定解決と起動時検証   ──► 失敗すればチェーンに一切触れずに終了
[B] チェーン準備            resetFork / automine / 資金配布 / approve
[C] 環境の構築              PriceFeed / venue setup / イベント準備
[D] 起動直前の検証          no-arb / deployment / 鍵衝突
[E] エージェント起動
[F] ブロックループ          ← run の本体
[G] 停止と teardown
[H] 採点と成果物書き出し
```

各段の詳細を以下に定義する。

### [A] 設定解決と起動時検証（L395–489）

1. `resolveRunInputs(process.argv, overrides)` が **`--config` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`** の順に config を解決する（→ [07](07-configuration.md)）。1 つも無ければエラー。
2. **`resetUnit` 検証**（L405）— config が `scenario` でも、それがシナリオ行列ランナーからのプログラム的 override として来ていなければ throw。
3. **`chainMode` の設置**（L422）— `setChainMode` を「チェーンに触れる何かより前に」呼ぶ。以降 cheatcode は呼ばれた瞬間に throw する。
4. `external` の場合、次の 5 条件を検証して throw する（L426–456）。

   | 条件 | 理由 |
   |---|---|
   | `TREASURY_PRIVATE_KEY` が無い | cheatcode の無いチェーンでは genesis prefund 済み口座からの送金しかない |
   | `run.localDeploy: false` | 外部チェーンは我々の venue デプロイを載せる。そのアドレス overlay を有効にするのが localDeploy |
   | `run.economicGas: true` | 価格の確定を storage 書き込みで行うため実チェーン不可 |
   | `stress.victimCount > 0` | victim は run ごとの fresh state を要求する |
   | `run.prewarmBlocks > 0` | warmup 自身がブロックを掘る。かつ温めるべき cold fork state が無い |

5. **セグメント長の助言**（L457–473）— `segmentHours: 0` かつ `runBlocks > 20,000`（2 秒 cadence で約 11 時間）なら警告を出す。**致命的ではない**：意図的に長い非分割 run は正当だが、驚きであってはならない。
6. **economicGas の前提**（L479）— `funding.ethWei < 0.5 ETH` なら throw（最初の一手でガス切れになる）。

### [B] チェーン準備（L491–871）

1. `runId` = ISO 時刻文字列。`segmentHours > 0` なら `SegmentedRun`、でなければ `RunLogger` が成果物を書く。
2. **`run_started_realtime`** を emit（L506）。seed / flowSeed / epochBlocks / rpcUrl / chainId / chainMode を含む。**seed を記録するのはここだけ**で、これが無い過去 run は「どの world だったか」を答えられない。
3. クライアント生成（`batch: true` = 同一 tick の read を JSON-RPC 配列バッチ / Multicall3 に自動集約）。
4. **リセット**：`external` ならスキップして `fork_reset_skipped` を emit。`run.skipReset` でもスキップ。それ以外は `resetFork`（fork なら再 fork、ローカルなら snapshot/revert のクリーン断面）。
5. ローカルデプロイかつ非 external なら **setup 中だけ automine を ON**（L563）。deployer anvil の automine 状態を引き継がないため。競技開始時に OFF に戻す（L1499）— automine のままだと 1 tx = 1 ブロックになり手数料競争が壊れる。
6. **ウォレットの解決**：`spec.address` があれば鍵なし（外部参加者）、無ければ `wallet` 名から鍵を引く。
7. **flow ウォレット**を `keccak256("flow:<seed>:<key>")` で決定論的に生成（protocol × {informed, uninformed}、aave actor × N、whale）。
8. **`EventSchedule` 構築**（L629）— `(config, seed, runBlocks)` の純関数でチェーン依存が無いので、資金配布より前に作れる。whale の endowment サイズが schedule に依存するため、この順序が必要。
9. **資金配布**（L797–871）：

   | 対象 | ETH | base | stable |
   |---|---|---|---|
   | agent | `funding.ethWei`（**ガスバッファ 0**） | `funding.wethWei` / `funding.base` | `funding.usdcUnits` |
   | flow ウォレット | `funding.flowEthWei` | `funding.flowWethWei` / `funding.flowBase` | 同上 |
   | aave actor | 同上 | `flow.aaveMaxWethWei × 6` | 同上 |

   エージェントのガスバッファを 0 にするのは、既定バッファが**選んでいない β** としてエポック系列に乗るため（ADR 0019 §6）。flow ウォレットは機械なのでバッファを持つ。
   鍵を持たない登録参加者へは `fundAddress` で配る（approve は本人しか出せないので付かない）。
   approve は venue 横断でまとめて 1 バッチ送信する（15 ウォレット × 18 tx を 1 ブロックずつ送ると 2 秒 cadence で 9 分かかる）。

### [C] 環境の構築（L873–1290）

| 順序 | 処理 | 備考 |
|---|---|---|
| 1 | `initialFairPrice` 確定 | 以降の較正・victim・whale が参照する |
| 2 | Aave オラクル較正（localDeploy 時） | anvil なら storage 書き込み、external なら admin の mined tx。どちらも agent 起動前なので front-run 不可 |
| 3 | whale endowment | サイズは fair price 建て。**venue が無効なら throw**（L904） |
| 4 | stress victim 構築 | `aave` 必須 / fresh state 必須（下記） |
| 5 | 各 agent の初期残高取得 + `initial_endowment` | 最大/最小が 2 倍超なら警告 |
| 6 | PriceFeed デプロイ → `price_feed_deployed` | このアドレスだけは参加者が他から引けない |
| 7 | FlashArb デプロイ（`run.flashArb` かつ aave+uniswap+balancer） | |
| 8 | vuln pool デプロイ（ADR 0014） | 資金投入は窓が開くブロックで行う |
| 9 | `agents_registered` emit | id / address / baseline / external |
| 10 | **環境マニフェスト書き出し** | 鍵は入らない。→ [10](10-operations.md) |
| 11 | prewarm（`run.prewarmBlocks > 0`） | flow bot だけの短いループで anvil の working set を温める。価格の主系列は消費しない（別 Rng） |
| 12 | LST setup | 経済クロックの整合 + rate oracle 配線の検証（乖離 200bps 超で fail-fast） |
| 13 | Liquity setup | オラクルアダプタを今回の PriceFeed に差し替え。Recovery Mode 開幕・デペグ済みチェーンは fail-fast |
| 14 | deployer 鍵の衝突検査 | liquidityPull / depeg が deployer 口座で取引するため（下記） |
| 15 | depeg runtime setup | |
| 16 | liquidityPull setup | |

**victim の fresh state 要件**（L955）：`!skipReset && (localDeploy || forkUrl)` でなければ throw。soft-reset だと前 run の victim ポジションが残留し HF 計算が壊れる。

**deployer 鍵の衝突**（L1155）：`liquidityPull` / `eusdDepeg` / `depeg` はいずれも deployer 口座（anvil account 0）で取引する。同じアドレスのエージェントがロスターにいると nonce を奪い合うので、**アドレス比較で**検出して throw する（鍵で比較すると、鍵を持たない登録参加者の衝突を見逃す）。

### [D] 起動直前の検証（L1293–1320）

**起動時 no-arb チェック** — 較正済みプールが**実行可能な**venue 間往復で利益を出してはならない。`STARTUP_FAIL_BPS` 超なら throw、`STARTUP_WARN_BPS` 超は警告して毎ブロック監視に引き継ぐ（→ [11](11-invariants.md)）。

### [E] エージェント起動（L1322–1365）

- `external: true` または鍵なしのエントリは**起動しない**。代わりに `agent_external_registered` を emit する。これが無いと「参加者が接続しなかった run」と「coordinator が起動に失敗した run」が区別できない（どちらも無取引に見える）。
- 起動したプロセスには `onExit` を付ける。**途中で死んだエージェントは黙って取引をやめる**ので、`summary.json` 上は「動かないことを選んだ」エージェントと見分けがつかない。`agent_process_exited` と `processExitedEarly` に残す。

### [F] ブロックループ

→ §2.2。

### [G] 停止と teardown（L2372–2419）

順序に意味がある。

1. **エージェントを止める**（採点より前。direct モードのエージェントは止めない限り注文を出し続ける）
2. flow プロセスを止める
3. interval mining を止める（external では行わない）
4. **`finalBlock` を確定**（teardown より前）— これ以降は環境が世界を元に戻す作業であり、そこを採点すると **teardown を採点する**ことになる。デペグの買い戻しは stable を par に戻すので、手仕舞わなかったエージェントが par で評価されてしまう
5. liquidityPull の restore / depeg の restore
6. `flushBlocks(finalBlock)` — blocks.csv を書き切る（`resetFork` が歴史を消す前）

### [H] 採点と成果物（L2421–2746）

1. **live エポック系列**（`LiveScorer.series()`）を取得。セグメント時は**現在のセグメント分に切る**（切らないと最終セグメントに週全体のエポックが入り、二重計上になる）
2. `scoreEpochSeriesByAgent` でスコア算出 → `epoch_series_scored`
3. **事後 sweep**：`finalBlock - runStartBlock <= 1000` のときだけ実行する。超える場合は `post_run_sweep_skipped` を emit して**明示的にスキップ**する（歴史保持深度を超えると 0 を読み、「崖のある完全な系列」になる）
4. sweep が走ったなら `market.json` も再構成（報告専用。失敗しても run は劣化しない）
5. **`epoch_series_agreement`** — 両方存在する run では live と sweep の一致を検査する。同じ reader・同じブロック・同じ median 窓なので一致するはずで、しないなら片方が別の世界を読んでいる
6. `postRunCheck` で手数料上限違反を検査（`economicGas` 時は空）
7. 最終 PnL 計算 → `summary.json` → `run_completed`

## 2.2 ブロックループの毎ブロック処理順

`watchBlockNumber` が新ブロックを通知するたびに `onBlock(bn)` が走る（L1771）。ポーリング間隔は `max(100ms, blockTimeSec × 1000 / 4)`。

**再入しない**（`processing` フラグ）。処理中に来た通知は捨てられるので、各段は「前回処理したブロックの次から今回まで」の**範囲**を扱う（`fromBlock..bn`）。1 ブロックだけを見る実装は、ドロップされた通知でイベントを丸ごと飲み込む。

| # | 段 | 内容 |
|---|---|---|
| 1 | 価格の前進 | OU で `baseFair` を進める。`cexDrift` は**walk 自体**を変える（drift 加算・kappa 弱化・anchor 移動） |
| 2 | overlay 適用 | `latestFairPrice = baseFair × overlay.wethMult`。extra base も各自の Rng で同様に |
| 3 | vuln pool funding | 窓に入ったプールへ準備金を投入（cheatcode） |
| 4 | 点イベント | `lstSlash` / `whale` を**範囲**で拾って実行。ブロックの他の仕事より前に置くので、そのブロックの観測には既に反映されている |
| 5 | **並列タスク群** | 下表 |
| 6 | `liveScorer.onBlock(bn)` | 並列群の**後**に逐次。直前に確定したブロックを読むので競合しない。毎ブロックではなくエポック境界でのみ横断面を読む |
| 7 | `flushBlocks(bn-1)` | セグメント時のみ。現在ブロックは環境の tx が飛行中なので `bn-1` まで |
| 8 | セグメントの roll 判定 | **境界読み取りの後**。境界上で終わるセグメントはそれを保持し、次セグメントが自分の境界 0 として引き継ぐ |
| 9 | `round_timing` emit | 各段の所要ミリ秒 |
| 10 | 終了判定 | `runBlocks > 0 && processedBlocks >= runBlocks` で終了 |

### 並列タスク（L2271–2290）

| タスク | 送信鍵 | 条件 |
|---|---|---|
| `keeperTask` | keeper | 常時（`adapter.afterMine`） |
| `oracleTask`（+ `accrueLstTask`） | admin | 常時。LST の accrue は**同じ admin 鍵なので直列**（並列にすると nonce 衝突でレートが凍る） |
| `stateAndFlowTask` | — | 常時。全 venue の `readState` → no-arb 監視 → LST/Liquity のブロック telemetry → flow bot へ context push |
| `victimTask` | — | victim がいる & 価格イベントが有効な窓のみ |
| `vulnTask` | — | vuln run のみ |
| `deployerKeyTask` | deployer | liquidityPull と depeg を**1 タスクに直列化**。同じ鍵で `Promise.all` に 2 つ置くと同じ pending nonce を解決して片方が黙って上書きされる |
| `liquityWatchTask` | — | liquity 有効時 |

### 手数料プロファイル

| プロファイル | oracle / PriceFeed | keeper | 上限強制 |
|---|---|---|---|
| 既定（ADR 0010） | `maxPriorityFee + 1 gwei` → `--order fees` で txIndex 0 | `maxPriorityFee + 0.5 gwei` | あり（事後検査） |
| `economicGas: true`（ADR 0011） | `defaultPriorityFee`（価格確定は storage 書き込みなので front-run の的が消える） | 同左 | **なし**（自由入札） |

## 2.3 時間の扱い

| ノブ | 意味 | 既定 |
|---|---|---|
| `run.blockTimeSec` | ブロック間隔（秒） | 2 |
| `run.blocks` | ブロック数で終了 | 0（= 無制限） |
| `run.seconds` | 実時間で終了 | 20 |
| `run.epochBlocks` | 1 エポックのブロック数 | 12 |
| `run.epochSeconds` | 1 エポックの実時間（秒）。`blockTimeSec` で換算 | 0（未使用） |

- **`epochSeconds` と `epochBlocks` の両方指定は throw**（`sdk/src/config.ts:576`）。「ラウンドの長さ」に 2 つの答えがある状態を排除する。
- **ストレス run は時間制限を自動無効化する**（L1737）。`stress.events` があり `run.blocks > 0` なら `run.seconds` を 0 にして、時間切れで crash 窓に到達しない事故を防ぐ。override は `stress_run_time_limit_disabled` に記録する。
- external では**実 cadence を計測**して `external_chain_block_time` に記録する。設定値とのズレは全エポック長を狂わせるため。

## 2.4 world のリセット単位（`run.resetUnit`）

**この run が 1 つの world なのか、(regime, seed) ごとに world を作り直した中の 1 本なのかというラベル**であり、これ自体は何もリセットしない（リセットしているのは `backtest --scenarios` の snapshot/revert）。

| 値 | 意味 | 宣言できる場所 |
|---|---|---|
| `continuous`（既定） | 開始から終了まで 1 つの world | どこでも |
| `scenario` | シナリオごとに world を作り直した中の 1 本 | **シナリオ行列ランナーのみ** |

- `summary.json` の `resetUnit` と `matrix.json` の `resetUnit` に必ず出る。
- `npm run metrics` は**モードが混ざった run 集合を拒否**する。1 world あたりのエポック数が違い、λ の実効的な厳しさが `λ/√(エポック長)` で動くため、Borda を取ると別々の競技を平均したものになる。
- フィールドを持たない過去 run は `continuous` として読む。
- 綴り間違いも fail-fast（`sdk/src/config.ts:42`）。黙って `continuous` に落ちると matrix 全体が continuous を名乗る。

## 2.5 セグメント（止まらないチェーンの出力分割）

`run.segmentHours > 0` で有効（`core/src/segments.ts`）。**チェーンは連続のまま、run ディレクトリだけを切る。**

- 1 セグメント = 通常の run ディレクトリ（同じファイル・同じ形）。競技ディレクトリ配下に `<日付>-s<NN>/` として並び、`matrix.json` がその索引になる。
- 索引の `resetUnit` は正直に `continuous`。
- **エポックは厳密に分割される**（`segments.ts:228` `sliceEpochSeries`）：
  - セグメントの開始**直前**の境界を、そのセグメントの境界 0 として引き継ぐ（引き継がないとセグメントごとに 1 エポック失われる）
  - ただし**境界の上で始まるセグメントは引き継がない**（引き継ぐと同じエポックが 2 セグメントで採点される）
- セグメントの時計は**最初のブロックが来た時点**で始まる（`noteFirstBlock`）。実チェーンの setup は数分かかるので、それを最初のセグメントに数えると初日が短くなる。
- 各セグメントの `summary.json` の PnL は**そのセグメントの端点**から取る（run の初期残高ではない）。連続経済における「火曜日の損益」は火曜日に変化した分。
- ラウンド数はセグメントで頭打ちになる。30 分ラウンド × 24h セグメントで **48 ラウンド/セグメント**が定常状態。

## 2.6 失敗の扱い

| 失敗 | 扱い |
|---|---|
| 起動時の較正・設定・デプロイの不整合 | **throw してチェーンに触れずに終了**（→ [11](11-invariants.md) に一覧） |
| ブロック処理中の例外 | `realtime_block_error` を emit してループは継続 |
| 個別タスクの失敗（keeper / oracle / liquidity / depeg / vuln / liquity watch） | 各々専用の `*_failed` イベントを emit して継続 |
| エポック境界の読み取り失敗 | **境界を記録しない**（`null` で埋めない）。`epoch_boundary_failed` を emit |
| 価値系列の再構成失敗 | `valueSeries.failed: true` として明示。他の成果物は残す |
| market.json の再構成失敗 | ログして飲み込む（報告専用なので run は劣化しない） |
| エージェントプロセスの異常終了 | `agent_process_exited` + `summary.agents[].processExitedEarly` |
