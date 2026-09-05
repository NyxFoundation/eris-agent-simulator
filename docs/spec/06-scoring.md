[← 目次](README.md) ｜ [← 05 エージェント契約](05-agent-contract.md) ｜ [07 設定 →](07-configuration.md)

# 06. 採点

出典 `core/src/scoring/{epochScore,metrics,aggregate}.ts`、`core/src/realtime/{liveScoring,reconstruct}.ts`、`core/src/backtest/standings.ts`、`sdk/src/{valuation,pnl,stables}.ts`。

## 6.1 採点の 4 層

```
[1] 保有 → USDC        トークン種別と venue アダプタが値付ける
[2] 横断面 → 系列       エポック境界で全エージェントを同一ブロックで読む
[3] 系列 → P            P = V_K − V_0（境界の両端。1 run につき 1 つ）
[4] エポック → 順位     場全体で T = 50 + 10 (P − μ) / σ → Score = Σ w·T / Σ w（規約 §4.4）
```

**層 1〜3 は 1 つの run で完結し、層 4 は場（同じエポックを走った全員）があって初めて存在する** — 行列の `standings.json` と dashboard が計算し、1 run の `summary.json` には P までしか入らない。 各層の出力はすべて保存されるので、下層を再実行せずに上層だけ差し替えられる（[00 §0.5 P5](00-overview.md)）。

## 6.2 層 1：保有の値付け

### spot（`sdk/src/valuation.ts`）

`tokenAmountUsd(token, amount, fairByBase, stablePrices)` が単一の入口。

| トークン | 価格 |
|---|---|
| `kind: "base"` | その run の fair price |
| `kind: "stable"` | 市場が払う額（`stablePriceUsdc`）。USDC は $1 固定 |
| レジストリ外の USDC 変種（USDC.e / USD₮0） | 6 decimals・$1 の慣行 |
| その他 | **`undefined` = 値付け不能**。0 ではない |

「値付けできない」を 0 にせず `undefined` で返すのが要点。以前は固定の位置型を列挙して他をすべて 0 としていたため、**リストに無い venue に価値を移すと全損として読めた**。

LP トークンは**プールの準備金に対する比例持分**で値付ける（`poolShareValueUsdc`）。Balancer weighted も Curve crypto も手数料なしで比率どおりに exit できるので、比例持分が実現可能な exit 価値そのものになる。venue 固有の価格式（virtual price / BPT rate）に依存しないという利点もある。

### venue（アダプタの `valueAtBlock`）

[01 §1.4](01-architecture.md) の段階生成器。アダプタは `valueUsdc`（マーク）と `liquidatableValueUsdc`（実現可能額）を返す。**採点が合計するのは前者**。

### 値付けから外れた保有の報告

`ScoringExclusionReason` は 4 種（`valuation.ts:42`）。

| reason | 意味 | 値に含まれるか |
|---|---|---|
| `unpriced` | 数量は分かるが USD 価格が無い | 含まない |
| `read-failed` | 読み取りに失敗したので保有が**不明**（0 ではない） | 含まない |
| `unrealizable` | 値付けはできるが run 終了までに換金できない（LST のキュー） | 含まない |
| `par-fallback` | 市場が quote を返さなかったので **$1 として計上した** | **含む** |

4 種すべてを `summary.json` の `valueSeries.unpricedHoldings` に報告する。**`summary.json` の 0 が取引損失と誤読されてはならず、1 ドルもまた同じ。**

### 未申告トークンの検出

`findUnaccountedTokens` が Transfer ログから「誰も合計していない ERC-20」を洗い出す。アダプタは `accountedTokens()` で「自分が値付けている / 集計値に含まれている」トークンを申告する。**venue が発行するが値付けていないトークンは申告しない**（見えたままにするため）。実例：Stability Pool の LQTY gain は `erc20-unaccounted` として 61.3 LQTY と報告された。

## 6.3 層 2：横断面と系列

### 2 つの経路

| 経路 | いつ | 何を作るか |
|---|---|---|
| **live**（`LiveScorer`） | エポック境界を通過するたび | 採点に使うエポック系列。`epochs.jsonl` と `epoch_boundary` イベント |
| **sweep**（`reconstructValueSeries`） | run 終了後（窓が 1,000 ブロック以内のとき） | equity curve・α・`unpricedHoldings`・`market.json` |

**両者は同じ reader（`readValueSnapshotAtBlock`）・同じブロック・同じ G7 median 窓を使う**ので一致する。それが「live が sweep の代替になる」という主張の根拠であり、両方存在する run では毎回 `epoch_series_agreement` で検査する（[11](11-invariants.md)）。

**live が必要な理由**（`liveScoring.ts:1-18`）：

1. 止まらないチェーンには「あと」が来ない
2. ノードの履歴保持深度は有限（anvil は約 1,050 ブロック）。「run を短くする」では 1 週間のチェーンに対処できない

### エポック境界

`epochBoundaryBlocks(fromBlock, toBlock, epochBlocks)`。E エポックには E+1 個の境界が要り、run の開始が境界 0 になる。

**末尾の端数エポックは落とす。** 他より短い窓は構造的に小さい log return を生み、指標はそれを「エージェントが減速した」と読んでしまう。

`--score-every N` は equity curve の間引きで、`fromBlock` と `toBlock` は必ず含む。**スコアは不変**（α は最初と最後の横断面しか使わない）。

### 読めなかった境界

**境界を記録しない**（`null` で埋めない）。系列は「値が無い」と「0」を区別する。境界ブロック自体を push しないので、系列は実際に読めた境界と整合したままになる。

### G7：マーク median（`MarkMedian`）

エポック境界を、**その直前 `markMedianBlocks` ブロックの median で評価する**（既定 5）。1 ブロックだけプールを押した結果がスコアになるのを防ぐ。窓の大半で成立していなければ効かないので、スプレッドコストを払う往復が「ポジション」に変わる。

**対象は市場価格 stable だけ**で、それで全面をカバーしている。

| 対象 | median するか | 理由 |
|---|---|---|
| 市場価格 stable（spot・Trove 債務・SP 預入） | **する** | プールの quote が**そのままマーク**であり、取得原価は別の場所にある。プールを動かすとスコアが動く |
| LP 持分 | しない | 準備金 × 環境の fair price で評価する。プールを押すとエージェントの 2 つのバケツの間で価値が移るだけ |
| LST | しない | 採点マークは額面（償還レート × WETH fair）でプールを一切読まない |

live 側と sweep 側で同じ窓を使う。実際に median がどれだけ効いたかは `valueSeries.markMedian.maxDeviationBps` に出る。

### α（β 除去 PnL）

sweep のみが作る。**固定した参照 fair price**（`alphaRefFairUsdcPerWeth`）で free inventory を評価し、`alphaByAgent = alphaLast − alphaFirst` を取る。最初と最後の横断面しか使わないので、間引きの影響を受けない。

**α が除去するのは free inventory の β だけ**である。venue ポジション（LST など）は live mark なので、USDC 建て採点では LST 保有戦略は構造的に β で不利になる（実測：noop 0 > lst-carry −203 > lst-carry-wide −233、一方 WETH を持たない venue-arb は +115）。

## 6.4 層 3：スコア（規約 §4.4 の偏差値。ADR 0022）

出典 `core/src/scoring/deviationScore.ts`。**1 エポック（= 1 run）につき数字は 1 つ**で、run 内の区間系列は使わない。

```
P(a, s)   = V_K − V_0                       USDC 損益。両端ともその境界のマーク（§4.1 の 5 ブロック中央値）
μ_s, σ_s  = 当該エポックに投入された全エージェントの P の平均と母標準偏差（ベンチマーク除外）
T(a, s)   = 50 + 10 × (P(a, s) − μ_s) / σ_s          偏差値
w_s       = 1 + 0.5 × (s − 1) / (k − 1)              最初 1、最後 1.5（k = 1 なら 1）
Score(a)  = Σ_{s∈S} w_s T(a, s) / Σ_{s∈S} w_s        S = 有効かつ σ_s > 0 のエポック
```

- **P は境界系列の両端**（`core/src/scoring/epochPnl.ts`、`summary.json` の `agents[].pnlUsdc`）。最終境界が読めなければ**読めた直近の境界**を使う（§4.4.2。`pnlFinalBoundaryIndex` に記録）。`netPnlUsdc`（両端を最終価格でマーク）とは全員同じ初期資本なら定数差なので偏差値は一致するが、規約が名指す量はこちら
- **母集団は投入された全員**。破産（資産価値 ≤ 0）も負の値のまま算入し、**床処理も凍結も無い**（§4.4.2）。ベンチマーク（ロスターの `baseline: true`）は値付け・表示するが母集団に入れない（§4.3）
- **σ_s = 0 のエポックと、環境側の事由で無効になったエポックは全員について S から外す**。他のエポックの重みは動かない（w_s は予定回次 s と k の関数）
- **投入されなかったエージェント**（summary に無い）はそのエポックの母集団に入らず、投入されたエポックだけで平均する
- 1 エポックの T は 50 ± 10√(n − 1) に有界（n = 母集団の人数）
- **失格は無い**（2026-09-06 の規約改定）。プロセスの異常終了・fee cap 違反・submitted ログに無い tx は `flags` として横に出るだけで P は変えない。§8 の判断は運営のもの

### 順位（§4.6）

- T と Score は**小数第 2 位**（第 3 位を四捨五入 = `round2`）で比較する
- 同点は (1) 自分の T 系列の母標準偏差が小さい方 → (2) 最悪エポックの T が大きい方 → (3) 最終提出時刻が早い方。それでも同じなら同着（順位を共有し、次の順位は繰り下がる）

## 6.5 層 4：シナリオ行列の順位（`core/src/backtest/standings.ts`）

- **行列の 1 シナリオ = 1 エポック**。回次 s は `{regimes, seeds}` の直積なら実行順、`{k, epochs: [{s, regime, seed}]}` のプラン（`npm run competition -- plan`）なら明示。k は集合の長さかプランの `k`
- `matrix.json`（schema 2）は per-agent の `pnlUsdc` / `pnlSource` / `netPnlUsdc` / `alphaUsdc` / 端点 / `baseline` / `flags` を保存し、`standings.json` は `computeStandings` の出力（`k` / `S` / `epochs`（μ・σ・n・w・除外理由）/ `agents`（rank・tied・score・epochs・tStd・worstT・flags）/ `benchmarks`）
- **summary.json が無いシナリオは全員について無効エポック**（§4.4.2）。一部の参加者だけ除外することはない
- `--metric` と `npm run metrics` は退役した（旧 M1…M27 / aggregate は削除）

### エポック順序と commit（規約 §3.3 / §7）

`core/src/competition/schedule.ts`。非公開 seed 集合（regime → seeds）と抽選 seed から、**各レジーム等回数**でエポック列を導出する。SHA-256 のカウンタモード + 棄却法 + Fisher-Yates で、抽選 seed が決めるのは順序（と余剰 seed の選択）だけ。両ファイルは正規化 JSON の sha256 で commit し（`npm run competition -- commit <file>`）、結果発表後に原本を公開する。

## 6.6 順位表の表示規則（ダッシュボード）

- `dashboard/src/data/standings.ts` は `@core/scoring/deviationScore` を **import する**（2 箇所に置くと CLI と画面で順位が食い違ったときどちらが本物か分からなくなる）
- スコア列 = Score（2 桁）。レジーム列 = そのレジームでの T の平均（説明であって別の順位ではない）。参考列 = net PnL（final marks）
- ラウンドスクラブ中は P = V_k − V_0 を境界系列から取り直して T と Score を再計算する（**未来を見せない**）
- agent ページの Standing タブ: 採点エポック一覧（s / シナリオ / P / T / w）、T の平均・標準偏差・最悪値（= タイブレーク）、レジーム別、破産（≤ 0 で終えたシナリオ）
- 1 run のリーダーボードはそのエポックの T（ベンチマークは —）。ラウンドの対数リターンは総資産価値の生の変化で、採点には使わない

詳細は [09](09-dashboard.md)。

## 6.7 採点に関する未決事項

| 論点 | 状態 |
|---|---|
| **k の値** | 付録A で提出期間の開始までに公表。推奨 40（8 レジーム × 5） |
| **非公開 seed / 抽選 seed の実物** | 生成と commit の公表は運営作業（`npm run competition -- commit`） |
| **LST の採点基礎** | 現行実装は par（額面）。issue #38 の意図は realizable。`lst` が競技セットに入る前に決める |

→ [12 既知の制約・未決事項](12-open-issues.md)
