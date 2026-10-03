# ADR 0023: 競技の採点を規約 §4.4 の偏差値方式にする

> 番号について: 2026-09-06 に ADR 0022 として起票したが、同日 main 側で issue #40 の
> [ADR 0022（エージェントが作る市場）](0022-agent-created-markets-and-round-trip-scoring.md) が先に
> 入っていたため 0023 に改番した。同日のコミットメッセージに残る「ADR 0022」は本 ADR を指す。

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

### V_0 は配布額を下限にする（Amendment 1、2026-10-02、issue #207）

**当初この ADR は V_0 を「最初の境界で読んだチェーン状態」としていた。**agent プロセスは最初の競技ブロックが
存在する前から動いている（場が揃うまでエポックの時計を待つため = issue #94）ので、その状態は agent が
作れる: 起動直後に配布バスケットを第 2 EOA か自作コントラクトへ出し、運用中に戻せば P = V_K − V_0 が
配布額（約 73k USDC）ぶん膨らむ。正直な戦略の P が ±200 の calm では桁違いになる。spawn と automine の
順序を入れ替えても塞がらない（automine 中は tx が即採掘される）ので、**定義で直す**。

- **V_0 = max(配布額, 実測)**。配布額は funding 直後の残高（`agent.initial`）を**その境界のマーク**
  （PriceFeed の fair と stable の中央値 = 実測と同じ価格）で評価した値。価格側は従来どおりで、
  保有側だけが agent に下げられない数になる（`core/src/scoring/endowmentV0.ts`）
- **置き換えではなく下限**なのは連続経済のため。練習 devnet の coordinator 再起動は EOA を代入で再配布
  するが venue の建玉は残る。それは環境が見える価値で agent の仕業ではないので、無視すると建玉を持つ全員に
  初日の偽の利益が出る。fresh world では恒等。鐘の前の利益だけは数えない（時計が始まっていない）
- 2 境界目以降は従来どおり実測。live scorer と事後 sweep の両方が同じ規則を同じブロックに当てるので
  `interval_series_agreement` は変わらない。α の最初の断面も同じ下限
- **記録**: `summary.json` の `agents[].v0Source`（`endowment` / `measured`）/ `v0Usdc` / `v0MeasuredUsdc` /
  `v0EndowmentUsdc`、`intervals.jsonl` 先頭行の `v0*ByAgent`、乖離が許容（0.1%）を超えた agent は
  `interval_v0_endowment_gap`。`matrix.json` の `flags` に実測と配布の乖離（0.1%）を出す。flags は P を変えない。
  **`pnlUsdc − netPnlUsdc` の場の定数からの外れは検出器にしない** — 2 つは別の評価を読む（netPnlUsdc は額面、
  P は換金可能額）ので差は純 spot 以外では定数にならず、固定 2% も中央絶対偏差ベースの帯も正直な戦略に立った
- **T は不変**。全員同じ配布なら定数差（上の「`netPnlUsdc` とは場全体で定数差」と同じ議論）で、実測 V_0 を
  使う理由が無かった

### 失格・凍結は無い

プロセスの異常終了、fee cap 違反、submitted ログに無い tx は `flags` として結果の横に出るだけで、P を変えない。
規約 §2.3 / §4.4.2 は止まった agent を「残したポジションで他と同じく採点」し、§8 の判断は運営のものだから。
ADR 0017 §4 の「失格は最下位より 1 標準偏差下」は退役。

### 入力の形

- **行列 = エポック列**。`backtest --scenarios` は `{regimes, seeds}` の直積（実行順が回次）と
  `{k, epochs: [{s, regime, seed}]}` の順序付きプランの両方を受ける。`matrix.json` は schema 2
  （per-agent `pnlUsdc` / `pnlSource` / `baseline` / `flags`、`k`）、`standings.json` は `computeStandings` の出力
- **エポック順序は抽選 seed から導出**（`deriveSchedule`）。SHA-256 のカウンタモード + 棄却法 + Fisher-Yates で、
  レジームは等回数、順序（と余剰 seed の選択）だけが seed に依る（**issue #186 で変更**: エポックごとにレジームを
  独立・一様に引く。等回数だと既出レジームを数えて残りを推測できたため）。非公開 seed 集合と抽選 seed は正規化 JSON の
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
- **未決**: k の値（付録A。推奨 40 = 8 レジーム × 5 — 公式レジームが 12 本になって 40 は拒否される。
  [ADR 0026](0026-live-week-schedule.md) が 60 = 12 × 5 を提案）、非公開 seed の実物と commit の公表、500 体を 1 チェーンで
  走らせる負荷試験（実測は 100 体・4 秒ブロックまで）、LST の採点基礎（par か realizable か）
