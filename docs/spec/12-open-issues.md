[← 目次](README.md) ｜ [← 11 品質保証](11-invariants.md)

# 12. 既知の制約・未決事項

**確定していないことを確定事項として書かない**ための章（[README](README.md) の記述規律 2）。

## 12.1 採点の未決事項

### λ の `scenario` 側較正

| | |
|---|---|
| 状態 | **未較正** |
| 内容 | 既知値（ADR 0019 の 0.25、[測定記録](../scoring-metric-measurements.md)の推奨 0.15）は**どちらも連続経済 × 12 ブロックエポック**で測ったもの |
| なぜ効くか | λ の実効的な厳しさは `λ/√(エポック長)` で動く。1 シナリオのエポック数はシナリオ数 S に依存し、**S は未決**（issue #36 待ち） |
| 帰結 | `npm run metrics` は `resetUnit` が混ざった run 集合を拒否する（[02 §2.4](02-runtime.md)）。混ぜて Borda を取ると別々の競技を平均したものになる |

### 指標の選択（M4 vs M9）

| | |
|---|---|
| 状態 | **開いている**（issue #56） |
| 内容 | M4（超過対数成長）と M9（`mean − λ·std`）は「より稼ぐが荒いエージェント」と「安定したエージェント」のどちらを上位にするかで食い違う |
| 再計算では決まらない | 両者はきっかり `λ·std` だけ違い、**順位が動くのはそのエージェントの 1 エポック Sharpe が λ を跨いだときだけ**。どちらが正しいかは計算ではなく設計判断 |
| 現状 | ADR 0019 はリスク調整指標（M9）を選んだ。`backtest` の既定は `netPnlUsdc`（**過去の行列と比較できる唯一の指標**だから） |

### シナリオ横断の集約方式

| | |
|---|---|
| 状態 | **後継未定** |
| 内容 | ADR 0019 は現行の z-score を「後継を挙げずに退役」と宣言した。issue #55 がその理由：1 体の −1,113 USDC が場の sd を 20.9 → 181.5 に膨らませ、他全員を 8.7 倍圧縮した |
| 候補 | `zscore` / `borda` / `mean`（[06 §6.6](06-scoring.md)）。`npm run metrics -- --matrix` が総当たりで比較できる |
| 現状の運用 | ダッシュボードは `zscore` 固定で表示し、再採点は CLI の仕事にしてある |

### LST の採点基礎（par か realizable か）

| | |
|---|---|
| 状態 | **未決** |
| 内容 | 採点が合計するのは `valueUsdc` = **face value（vault が負う par）**。`realizableWethWei` は `liquidatableValueUsdc` に入る診断値 |
| 対立 | issue #38 の意図は realizable、現行実装は par（ADR 0019 §3 が採点の基礎に「通常の live mark」を選んだ結果でもある） |
| 期限 | **`lst` が競技セットに入る前に決める** |

### ETH 建て採点

USDC 建てでは LST 保有戦略が構造的に β で不利になる（実測：noop 0 > lst-carry −203 > lst-carry-wide −233、WETH を持たない venue-arb は +115）。α は free inventory の β しか除去せず、LST ポジションは live mark のため。**ETH 建て採点（DAT 型）が issue #38 の motivation で follow-on。**

## 12.2 環境の未決事項・構造的制約

### シナリオ数 S

`scenario` モードの 1 シナリオあたりのエポック数を決める値で、**直列に並べるか並列に走らせるかも含めて未決**（issue #36）。λ の較正がこれを待っている。

### Recovery Mode は現状の較正では到達不能

| | |
|---|---|
| 実測 | seed 501 で最小 TCR 2.244 対 CCR 1.5 |
| 原因 | genesis Trove が 250 ETH / 250k eUSD（300%）で TCR を支配する |
| 到達させると壊れるもの | system 債務を約 3 倍にする必要があり、それは償還手数料カーブ（供給に反比例。250k で 5k 償還あたり +100bps → 700k なら +36bps）と SP の相対深度（RM の清算は SP が債務を全額吸収できる場合のみ成立）を**必ず薄める** |
| 状態 | **issue #59 に分離** |

### fork モードで使えない venue

`lst` と `liquity` は Arbitrum に対応物が無い（vault は自作、Liquity は自前デプロイ）ので、fork では**起動時 fail-fast**する。fork を使う理由はもう無く（ローカルデプロイの方が速く安定する）、既定はローカルデプロイ。

### アセット間相関は 0

per-base の Rng が完全に独立している（`sdk/src/rng.ts:120-124`）。相関を入れるには共有 Rng へ統合する必要があり、それは WETH の消費列を変えて後方互換を壊すので**既定では行っていない**。

### `economicGas` は external チェーンで使えない

価格の確定を storage 書き込みで行う（front-run の的を消す）ため、実チェーンでは不可能。**issue #33 (2) の再設計待ち**で、それまでは tx ベースのプロファイルを使う（ADR 0021 Negative）。

### 市場価格 stable の Aave 伝播は現状 no-op

`stableAaveAggregators` は実装済みだが、**現在どの市場価格 stable も Aave reserve ではない**（`aaveReserveSymbols()` は base + USDC + LST）。listing した日に効く。プール読み取り 1 回のコストだけ払っている。

### `run.readRpcUrl` は口だけ開けてある

read を replica へ分離する経路は実装済みだが、**実際に分離するかは issue #36 の判断待ち**。

## 12.3 運用上の制約

| 制約 | 内容 |
|---|---|
| **anvil の履歴保持深度** | 約 1,050 ブロック。事後 sweep は 1,000 ブロックを上限とし、超える run では**明示的にスキップ**する（equity curve・α・`market.json` を失う） |
| **run の非決定性** | 同一 seed でも tx のタイミングと着順は非決定。run 単体の比較には意味がなく、比較にはサンプルの蓄積が要る |
| **spot AMI の焼き直し** | ADR 0015 の workspace 化で npm install の対象とパス前提が変わったため、次回 spot 利用時は `/spot-bake` が必要 |
| **アドレス overlay は同時に 1 つ** | deployment を移るたびに `gen:local-constants` の再生成が要る |
| **クラッシュ run の `blocks.csv`** | 通常 run は終了時に一括で書くので空になる |
| **`--only` 部分再デプロイ** | 共有トークンも作り直すので venue 間でアドレス不整合になる。焼き直しは全 venue まとめて |

## 12.4 意図的に「やらない」もの

これらは未決ではなく**決めた結果**である。

| 項目 | 理由 |
|---|---|
| **自己改善の自動 rollback** | 閾値に妥当な値が無い。旧実装は 18 run 中 0 件発火、逆に「少しでも負けたら」だと全員が負けるレジームで毎回巻き戻る。戻すかどうかはモデルの判断（[05 §5.7](05-agent-contract.md)） |
| **毎判断 LLM（prompt モード）** | 実測で 1 判断 8〜28 ブロック・行動回数がルール型の 1/64。競技として成立しない（ADR 0018） |
| **G2 のチェーン側強制** | 破産凍結は採点規則であってチェーン規則ではない。実チェーンでは参加者がシーケンサに直接届く（ADR 0019 §5） |
| **self-stranding の防止** | Liquity の担保は native ETH でガスと同じ残高。全部突っ込んで tx を送れなくなるのは**正当な負け**。観測に `suggestedGasReserveWei` を出すが強制しない |
| **submitted-but-not-included の追跡（external）** | 運営が動かしていないエージェントでは原理的に検証不能 |
| **リセット（練習 devnet）** | 練習場ではそれが設計（ADR 0021 §1） |
| **`liquidityPull` の magnitude 1.0** | 板が消えると全 swap が revert して「薄い板」ではなく「停止」になる |

## 12.5 撤去済みで復元されないもの

| 項目 | 状態 |
|---|---|
| 旧 LLM 自己改善機構（`src/llm`）と未参照戦略の `_archive/` | 削除済み（復元は `git checkout 4a65a8f -- _archive`） |
| 旧形式 `prompt.md`（毎判断プロンプト）19 個 | `f42fd2a` で削除。**git 履歴と旧 bundle には残る**ので `kind: improve` マーカーで区別する |
| `directShim` / `relay` / stdin-stdout プロトコル | 退役（`ERIS_AGENT_DIRECT_TX` も） |
| 評価・採点・可視化コマンド（`sim` / `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`） | 撤去 |
| ダッシュボードの `/standings`・`/leaderboard`・`/archive`・`/run` | 削除（[09 §9.1](09-dashboard.md)） |
| env からの config 読み取り | 廃止。設定されていると警告する |

## 12.6 参照

- 測定の一次記録：[`docs/scoring-metric-measurements.md`](../scoring-metric-measurements.md)
- 意思決定の経緯：[`docs/adr/`](../adr/)（ADR 0001–0021）
- 参加者向けの規則：[`docs/competition-rules.md`](../competition-rules.md)
