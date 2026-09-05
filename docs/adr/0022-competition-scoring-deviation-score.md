# ADR 0022: 競技の採点を規約 §4.4 の偏差値方式にする

## Status

Accepted（2026-09-06）

**実装済み（同日）**: `core/src/scoring/deviationScore.ts`（式・丸め・タイブレーク）/ `core/src/scoring/epochPnl.ts`
（P の読み出し）/ `core/src/backtest/standings.ts`（行列の順位）/ `core/src/competition/schedule.ts` +
`npm run competition`（抽選 seed からのエポック順序と commit）/ dashboard の順位表・agent ページ・1 run の
リーダーボード。**旧機構は削除した**: `epochScore.ts`（M9 `mean − λ·std`）、`metrics.ts` と `npm run metrics`
（M1…M27 の総当たり）、`aggregate.ts`（zscore / borda / mean）、`summary.json` の `epochScores`、backtest の
`--metric`、失格（`disqualified`）。ADR 0019 と ADR 0020 §5 はこの ADR が置き換える。

## Context

競技規約（ascon-web `content/legal/rules.md`、2026-09-22 発効）が §4.4 で採点を確定した。1 エポック（= この
repo の 1 run）につき数字は 1 つ、それを全参加者横断の偏差値にし、後のエポックほど重い線形の重みで平均する。
λ も、シナリオ横断の集約方式も無い。

それまで本 repo は 2 つの自由度を残していた。ADR 0019 の M9（`mean − λ·std` の超過対数リターン）は λ が未較正で、
ADR 0020 §5 は集約方式（zscore / borda / mean）を候補のまま置いていた。実測（`matrix-metric-merged2`、21 シナリオ
× 11 体）では netPnl / alpha / M4 / M9 の 4 指標で順位が同一で、選択は計算では決まらない設計判断だった。規約が
無パラメータの式を選んだことで、この 2 つの問いは消えた。

同じ日に規約はさらに 2 点を改定した。**評価グループの分割を廃止**し全参加単位を 1 本のチェーンで走らせる
（§3.3 / 旧 §3.4）、そして**タイムアウト・異常終了時の再起動と凍結を廃止**する（§2.3 / §4.4.2 / §4.5）。
どちらも採点の入力（母集団と P の定義）に効く。

## Decision

### 式（規約 §4.4.1・§4.6）

```
P(a, s)   = V_K − V_0                       エポック s の USDC 損益。両端ともその境界のマーク（§4.1 の 5 ブロック中央値）
μ_s, σ_s  = 当該エポックに投入された全エージェントの P の平均と母標準偏差。ベンチマークは除く
T(a, s)   = 50 + 10 (P(a, s) − μ_s) / σ_s
w_s       = 1 + 0.5 (s − 1) / (k − 1)       最初 1、最後 1.5。k = 1 なら 1
Score(a)  = Σ_{s∈S} w_s T(a, s) / Σ_{s∈S} w_s      S = 有効かつ σ_s > 0 のエポック
```

- **P は境界系列の両端**（`epochPnlFromSeries`）。`summary.json` の `agents[].pnlUsdc`。最終境界が読めなければ
  読めた直近の境界を使う（§4.4.2）。`netPnlUsdc`（両端を最終価格でマーク）とは、全員が同じ初期資本なら
  場全体で定数差なので偏差値は一致するが、規約が名指す量はこちら
- **母集団は投入された全員**。破産（資産価値 ≤ 0）は負の値のまま算入し**床処理は無い**（§4.4.2）。
  ベンチマーク（ロスターの `baseline: true`）は値付け・表示するが母集団に入れない（§4.3）
- **σ_s = 0 のエポックと環境側の事由で無効になったエポックは全員について S から外し、他のエポックの重みは動かさない**。
  w_s は予定回次 s と k だけの関数で、実際に走ったエポック数には依存しない
- **投入されなかったエージェント**（summary に無い）はそのエポックの母集団に入らず、投入されたエポックだけで平均する
- **順位は小数第 2 位**（第 3 位を四捨五入）。同点は T の母標準偏差が小さい → 最悪エポックの T が大きい → 最終提出が
  早い、の順。それでも同じなら同着で次の順位は繰り下がる

### 失格・凍結は無い

プロセスの異常終了、fee cap 違反、submitted ログに無い tx は `flags` として結果の横に出るだけで、P を変えない。
規約 §2.3 / §4.4.2 は止まった agent を「残したポジションで他と同じく採点」し、§8 の判断は運営のものだから。
ADR 0017 §4 の「失格は最下位より 1 標準偏差下」は退役。

### 入力の形

- **行列 = エポック列**。`backtest --scenarios` は `{regimes, seeds}` の直積（実行順が回次）と
  `{k, epochs: [{s, regime, seed}]}` の順序付きプランの両方を受ける。`matrix.json` は schema 2
  （per-agent `pnlUsdc` / `pnlSource` / `baseline` / `flags`、`k`）、`standings.json` は `computeStandings` の出力
- **エポック順序は抽選 seed から導出**（`deriveSchedule`）。SHA-256 のカウンタモード + 棄却法 + Fisher-Yates で、
  レジームは等回数、順序（と余剰 seed の選択）だけが seed に依る。非公開 seed 集合と抽選 seed は正規化 JSON の
  sha256 で commit し（`npm run competition -- commit`）、結果発表後に原本を公開する（§7.1 / §7.2）
- **dashboard は core の同じモジュールを import する**。順位のロジックを 2 箇所に置かない

### 削除

M9 / λ / 集約候補 / `npm run metrics` / `epochScores` / `--metric` / 失格。**理由は「2 つ目の答えを残さない」**。
CLAUDE.md の原則（「競技とは何か」に 2 つ目の答えを残さない）と同じ。

## Consequences

- **過去の matrix.json と順位は比較できない**。schema 1 の行列は `netPnlUsdc` を P として読める（`pnlSource:
  "endpoints"`）が、M9 で並べた旧 standings とは別物
- **λ の較正問題（ADR 0019 §8、issue #56）と集約方式の選択（ADR 0020 §5、issue #55）は消える**。#55 が指摘した
  「1 体が場の sd を膨らませる」性質は偏差値にもあるが、1 エポックの T は 50 ± 10√(n − 1) に有界で、n = 500 では
  1 体の影響は薄まる
- **1 run 内の 12 ブロック区間（ラウンド）は採点に使わない**。規約 §0.1 のとおりリーダーボードの途中経過で、
  dashboard のラウンド軸はそのまま残る。1 run のリーダーボードは「そのエポックの T」を出す
- **練習 devnet のセグメントも同じ式**で並ぶ（1 セグメント = 1 エポック）。ただし練習は公式採点ではない（ADR 0021）
- **未決**: k の値（付録A。推奨 40 = 8 レジーム × 5）、非公開 seed の実物と commit の公表、500 体を 1 チェーンで
  走らせる負荷試験（実測は 100 体・4 秒ブロックまで）、LST の採点基礎（par か realizable か）
