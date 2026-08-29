# CLAUDE.md

eris-competition-poc は Anvil で Arbitrum をフォークする DeFi トレード競争シミュレータ。

## パッケージ構成（core/sdk/example 3 workspace。ADR 0015）

```
sdk/       @eris/sdk — 契約レイヤ（types / action(zod) / chain / markets / protocols / observationFor / SimConfig）
core/      環境デーモン + 採点（realtime coordinator / anvil / flow / stress / vuln / cli）。参加者は触らない
example/   参加者テンプレート。example/agents/ がコピー・提出の単位
deployer/  venue デプロイ（自己完結サブパッケージ。workspace 外）
```

依存方向は **`example → sdk ← core`** のみ（`npm run check:boundaries` が検査）。
旧 `src/` / `examples/` は撤去済み。旧 LLM 自己改善機構（src/llm）と未参照戦略の `_archive/` も削除済み
（復元は `git checkout 4a65a8f -- _archive`）。

## エージェントの書き方（1 agent = 1 ディレクトリ。ADR 0015 §2-4）

`example/agents/<id>/` に次のいずれか 1 枚を置き、ロスターに id を足すだけで agent が増える:

| 中身 | 種別 | 動き方 |
|------|------|--------|
| `agent.ts`（`decide(obs, ctx)` export） | ルール戦略 | runtime/bot.ts が read→decide→send のループで駆動（`export const config = { intervalMs }` で間隔指定可） |
| `agent.ts`（`run(ctx)` export） | 自走型 | bot.ts はループせず ctx（clients/observe/submit/log）を渡して委譲（例 liquidator） |
| `agent.ts` + `prompt.md`（frontmatter: **`kind: improve`** / name / description 必須） | **自己改善型**（ADR 0018） | decide を毎ブロック駆動しつつ、LLM が取引経路の**外**で戦略コードを書き換える |

`runtime/`（汎用スクリプト: bot/read/send/llm/improve/deploy/agentLog）と `lib/`（共有戦略ヘルパ）は予約名。

**プロンプト型（毎判断 LLM）は ADR 0018 で廃止**。実測で 1 判断 8〜28 ブロック・行動回数がルール型の
1/64 で競技として成立しなかった（ADR 0017 §5 B1）。`ERIS_AGENT_MODE` / `ERIS_PROMPT_*` は fail-fast する。

**`prompt.md` は同じ名前で意味が逆になっている**（ADR 0018 Amendment 1。当初は `improve.md` という別名で
分離していたのを、名前を戻した）。旧 prompt.md は「この observation でどう動くか」、今の prompt.md は
「いつ・何を根拠に・どう直すか」。旧形式 19 個は f42fd2a で削除済みだが git 履歴と旧 bundle には残っており、
**frontmatter のキー（name/description）も同じ**なので、区別できるのは `kind: improve` だけ。マーカーの無い
prompt.md は**起動時に fail-fast**（黙って読むと、取引指示が「改訂方針」として system prompt に入る）。
`improve.md` だけがあるディレクトリも fail-fast（黙って無改訂で走ると、LLM が一度も動かなかったことが
どこにも出ない）。ロスターの `env`:

- `ERIS_AGENT_FROZEN: "1"` — prompt.md を無視して戦略を固定。**ADR 0018 §5 が要求する frozen 対照**
  （自己改善が効いたかを毎 run 見えるようにする）をディレクトリ複製なしで作る
- `ERIS_LLM_MODEL: "<model>"` — 改訂呼び出しのバックエンド（prompt.md の frontmatter が優先）。
  API キー無しでも `codex[:<m>]` / `claude-cli[:<m>]` でサブスク CLI 実行可 = docs/guide/llm-agents.md
- `ERIS_IMPROVE_LOG_CALLS: "1"` — 改訂の生のやり取りを `agents/<id>.llm.jsonl` に残す（既定 off）

改訂プロンプトは**その run で有効な venue の action 名を列挙する**（`ACTION_TYPES_BY_PROTOCOL`。
`sdk/src/action.ts` が単一の出典で、`test/actionVocabulary.test.ts` が改名・削除を検出）。渡さないと
LLM の手掛かりは現在の戦略コードだけになり、**一度も swap したことのない戦略は `swap` の存在を
知りようがない**（実測: USDC-only 配布で `lp-provider` が 18/18 シナリオ無取引 =
`docs/scoring-metric-measurements.md` §5.8）。「持っていないことは何もしない理由にならない」も明記する。
改訂は `{notes, executorTs}` か `{notes, revertTo: <version>}` を返し、`executorTs: null` は
「今の戦略を維持」。生成コードは **cheatcode 静的検査 → コンパイル → 2 秒の実行上限**を通ってから設置。
**自動 rollback は無い**（閾値に妥当な値が無いため。旧実装は 18 run 中 0 件発火、逆に「少しでも負けたら」
だと全員が負けるレジームで毎回巻き戻る）。戻すかどうかはモデルの判断で、版履歴を渡して `revertTo` で行う。
LLM バックエンドが無くても run は完走し、改訂失敗が記録されて戦略は無改変で走り続ける。
directShim / relay / stdin-stdout プロトコルは廃止済み（ERIS_AGENT_DIRECT_TX は退役）。

## 設定（YAML 単一ソース。ADR 0013）

run の設定値とエージェントロスターは **`config/local.yaml` 一本**で管理する（env からの設定読取は廃止）。
解決順は `--config <path>` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`（committed 雛形 = zero-config 既定）。
**雛形は `run.localDeploy: true` 既定**（README Quick Start と config/regimes/* に揃えた。fork 用フラグは不要になり
`npm run sim:realtime` だけで走る）。fork に戻すには `localDeploy: false` + `run.protocols` から `lst` を外す
（LST の vault は自作で Arbitrum に対応物が無い）+ `ARB_RPC_URL` + 別端末で `npm run anvil`。
キーは**ネスト lowercase**（`run` / `funding` / `limits` / `flow` / `stress` / `vuln` + `agents`）で
`sdk/src/runConfig.ts` の `SCHEMA` が内部キーへ写す。ロスターは規約解決（ADR 0015 §6）:

```yaml
agents:
  - id: arb-bot                # example/agents/arb-bot/ を runtime/bot.ts が駆動
    wallet: AGENT2_PRIVATE_KEY
  - id: clean-arb-wide         # 同一戦略の複数体は dir で実体ディレクトリを指す
    dir: clean-arb
    wallet: AUTO
    env: { ERIS_ARB_SAFETY_BPS: "150" }   # agent プロセスへ渡す戦略パラメータ
```

明示 `command`/`args` は完全自前 agent（他言語等。read/send/validate 全部自前 = サポート外）の override。
**env に残るのは秘密情報（`.env.local`: RPC/鍵/API キー）・agent IPC（`ERIS_AGENT_*`）・設定ファイル選択
（`ERIS_CONFIG`）のみ**。run ノブは CLI フラグ（`--seed` / `--blocks` / `--protocols` / `--agents` 等）で
一回限り上書きできる。

### `run.resetUnit` — world のリセット単位（ADR 0020）

`continuous`（既定）/ `scenario` の 2 値。**この run が 1 つの world なのか、(regime, seed) ごとに
world を作り直した中の 1 本なのかというラベル**で、これ自体は何もリセットしない（リセットしているのは
`backtest --scenarios` の snapshot/revert）。**本番競技は `scenario`**（ADR 0020 §2。在庫の持ち越し・
drawdown からの回復・レジームをまたぐ資本配分は競技の対象外になった）。既定が `continuous` なのは
`sim:realtime` との互換であって本番の宣言ではない。

- **`scenario` を宣言できるのは matrix runner だけ**。config に書いて `sim:realtime` を叩くと
  **起動時 fail-fast**（1 つの world を「多数」と名乗る summary.json は、後から検出できない嘘になる）。
  値の綴り間違いも fail-fast（黙って continuous に落ちると、matrix 全体が continuous と名乗る）
- `summary.json` の `resetUnit` と `matrix.json` の `resetUnit` に必ず出る。`npm run metrics` は
  **モードが混ざった run 集合を拒否**する（1 world あたりの epoch 数が違い、λ の実効的な厳しさが
  `λ/√(epoch 長)` で動くので、Borda を取ると別々の競技を平均したものになる）。フィールドが無い
  過去 run は `continuous` として読む（軸ができる前の run は全部 1 world だった）
- **λ は `scenario` 側が未較正**。既知値（ADR 0019 の 0.25 / 測定記録の推奨 0.15）はどちらも
  連続経済 × 12 ブロック epoch のもの。1 シナリオの epoch 数はシナリオ数 S に依存し、S は未決（#36 待ち）

## 実行コマンド

- `npm run anvil` — 別ターミナルで Anvil フォークを起動（sim:realtime の前提。ローカルデプロイモードでは不要）
- `npm run sim:realtime` — 実時間 run を 1 回実行（設定は `config/local.yaml`。`--config <path>` で別ファイル、`--seed`/`--blocks`/`--protocols`/`--agents` 等で一回上書き）
- `npm run build:contracts` — モックオラクル + PriceFeed を forge build（sim:realtime の前提。`out/` 未生成なら最低 1 回）
- `npm run gen:local-constants` — deployments.json → `sdk/src/constants.local.ts` 生成（同梱 `deployer/` のローカルデプロイ出力を読む）
- `npm run gen:state-dump` — 稼働中の deployer anvil から配布用 state dump + manifest（生成元コミット・deployments 同梱・fingerprint）を `backtest/state/` へ生成（ADR 0016。dump 前に `.local-snapshot` のクリーン断面へ revert し、constants.local.ts も同じ deployments から再生成）
- `npm run backtest -- --regime <name> --seed <N>` — シナリオ 1 本を再生（ADR 0016 Phase 0 = B1 実時間再生）。state dump をロードした専用 anvil（既定 port 8547）で `config/regimes/<name>.yaml` + seed を再生する。**シナリオ = (regime, seed)** で regime YAML は seed を持たないので `--seed` は必須（ADR 0017 §1）。`--agents <roster>`（regime 既定ロスターの差し替え）/ `--protocols`/`--blocks`/`--score-every` 等の一回上書き。**override は実効 regime YAML に書き出されて agent プロセスにも伝播**（coordinator だけに効かせると agent が観測で死ぬ）。fingerprint 不一致は manifest 同梱 deployments から constants を自動再生成、genesis 不一致は fail-fast
- `npm run backtest -- --scenarios config/scenarios/public.yaml` — シナリオ行列を 1 つの anvil 上で全部再生し順位を出す（ADR 0017）。`{regimes, seeds}` の直積で、シナリオ間は snapshot/revert。`runs/matrix-<id>/matrix.json`（シナリオ × agent の生スコア。**4 指標すべて**）と `standings.json`（レジーム内 z-score → レジーム等重み平均）を書く。順位は派生物で、採点方法は将来見直す前提（matrix.json から再計算できる）。`--metric netPnlUsdc|alphaUsdc|excessLogGrowth|score` / `--repeat N`（較正の診断用。採点は 1 回が既定）
  - **`excessLogGrowth`(M4) と `score`(M9) は epoch 系列から採る**（`summary.json` の `epochScores`）。M4 は M9 が採点したのと**同じ系列の合計**で取る（端点から取らない）ので、両者の差はきっかり `λ·std` になり、破産した agent の M4 は G1/G2 が凍結した後の系列を反映する。**順位が動くのはその agent の 1 epoch あたり Sharpe が λ を跨いだときだけ**。#56 の判断が開いている間、どちらも選べるようにしてある（既定は `netPnlUsdc` = 過去の行列と比較可能な唯一の指標）
  - **公式レジーム**: `calm` / `cex-drift`（OU に drift、kappa 弱化）/ `informed-flow`（相関した方向性フロー）/ `whale`（単発大口の点イベント）/ `lending-incident`（暴落 + victim + 清算 + 同じ窓の引き抜き）/ `crash`（価格ギャップ + 同じ窓での引き抜き。3 venue が同時に薄くなる）/ `depeg`（レジストリの stable が $1 でなくなる。issue #27）。`lst` / `liquity` は競技セット外（venue 単体検証用）
  - `--score-every N` は採点断面の間引き。成績は初期/最終断面しか使わない（`alphaByAgent = alphaLast − alphaFirst`）ので**スコアは不変**、equity curve が粗くなるだけ
- `npm run metrics -- <runDir...>` — 保存済み run を**全候補指標で採点し直す**（issue #56。M1 PnL / M4 超過対数成長 / M7 MPPM / M9 `mean−λ·std` / M13 Sharpe と、run 集合に対する M27 Borda）。チェーン不要・再 run 不要で `summary.json` の epoch 系列だけを読む。`--lambda` / `--rho` / `--out <path>`。**`resetUnit` が混ざった run 集合は拒否**する（ADR 0020 §1）。実測の記録は `docs/scoring-metric-measurements.md`
- `npm run metrics -- --matrix runs/matrix-<id>` — **シナリオ行列を「指標 × 集約」の総当たりで採点し直す**（ADR 0020 §5）。連続経済では「どの指標か」だけが問いだが、`scenario` モードでは**シナリオ横断の集約**という第 2 の選択が要る（`core/src/scoring/aggregate.ts` = `zscore` 現行 / `borda` 順位 / `mean` 絶対量。どれもレジーム等重み）。出力は各組み合わせの順位、M9×zscore との一致/不一致、そして **#55 の露出**（1 体が場の sd を何倍に膨らませているか。1.0 = 誰も場のスケールを決めていない）。matrix.json の `runDir` は相対なので、spot から回収した tarball を展開したディレクトリでもそのまま読める
- `npm run explorer` — sim anvil を索引するローカル Blockscout（issue #31。stock イメージ pin、`infra/blockscout/`）。UI は http://localhost:3100。**チェーンをリセットしたら `npm run explorer:reset`**（resetFork/snapshot-revert の巻き戻しに indexer は追従できないので DB を消して再索引するのが正規のライフサイクル）。`npm run explorer:tag` が最新 run の `summary.json` から agent アドレスに名前タグを付ける（reset で消えるので run ごと）。接続先・chain id・fork 用 `FIRST_BLOCK` は `infra/blockscout/explorer.env`
- `npm run dashboard` — run を描画する web UI（`dashboard/` workspace = issue #63。Vite dev サーバー http://localhost:5173）。サイドバーの run picker で `runs/<id>/` を選び、`summary.json` / `events.jsonl` / `blocks.csv` / `agents/*.jsonl` / `market.json` から全ビューを構成する。**実行中の run は `● (live)` として現れ観戦できる**（events/agent jsonl の tail + agent ログの `runtime_start` から発見した anvil RPC の現ブロック読取。採点・venue 系列は完走時に自動で archived 表示へ切り替わる）。Blockscout が起動していれば tx/block/address が deep link になり indexer 高さも併記される（落ちていればリンクだけ消える）。UI 開発用の seed データは `VITE_DATA_PROVIDER=seed`
  - **「ラウンド」= 採点エポック**（ADR 0019。run ではない）。上部の帯は選択中 run の epoch 系列そのもの
    （`valueSeries.epochSeries.boundaryBlocks`）で、セグメントを押すとその round の per-agent 結果
    （Δ value / 超過対数リターン / 順位と変動 / その窓に落ちた環境イベント）が開き、`/explorer` の
    ブロック窓もそこに絞られる。**`Δ value` と `log return` は別物**（前者は β 込みの生の資産変化なので
    noop も動く。後者は baseline 超過＝スコアが平均する系列）。live run は採点系列が無いので
    `run_started_realtime.epochBlocks` から枠だけ引いて進捗を出し、結果は完走時に入る
  - **`/markets` は価格ではなく venue の状態**。有効な protocol ごとに 1 タブ（AMM / Perp / Lending /
    Stablecoin / LST）。AMM・Perp・Lending・stable 価格は `market.json`、**LST と Liquity の
    「市場全体の状態」は `events.jsonl` の `lst_block` / `liquity_block`**（coordinator が毎ブロック
    出しているので二重に再構成しない＝古い run でも描ける）。パネルの構築は
    `dashboard/src/data/venuePanels.ts`
  - **リプレイ**: 完走した run を「ブロック B 時点」として前に歩かせる（rounds bar の `▶ replay`
    → play/pause・スクラバ・1x/2x/4x）。live モードは run したマシンでしか成立しない（tail は dev
    サーバーのファイルシステム、チェーン読取は agent の anvil）ので、**完走済み run と spot で回して
    回収した run を観るにはこれが唯一の手段**。archived は live より情報が多い（market.json・採点済み
    epoch・完全な blocks.csv）ので、劣化版ではなく上位互換。**未来を見せないのが要件**で、閉じていない
    ラウンドは結果を持たず、順位も閉じたラウンドまでの `mean−λ·std` で計算し直す（完走時のスコアを
    読むと毎フレームに答えが出てしまう）。run 終端の建玉断面も head が終端に届くまで落とす。
    **spot から回収した run はそのまま開ける** — `spot-run` は box の `runs/` 丸ごとを tar で持ち帰り
    `runs/<回収ID>/runs/<runID>/` に展開するので、dev サーバーの index は 2 階層下まで走査し、
    `runs/` からの相対パスを id にする（picker には `<runID> ← <回収ID>` と出る）
  - **`Scenario` タブが run の履歴**（既定タブ）。`stress_schedule`（seed から引かれた台形の計画）を
    絶対ブロック窓・またがるラウンド・実際に発火したブロック・終わり方（restored / failed）に変換し、
    清算・償還・slash・開いた arb 窓を時系列で並べる。**`crash`/`spike`/`cexDrift`/`flowTrend` は
    毎ブロックの記録を残さない**（価格の walk 自体を変えるので）ため「never fired」とは書かず
    「price chart を見よ」と出す。**seed は `run_started_realtime` に記録**（無い古い run は stat 自体を出さない）
  - **パネルは選択中ラウンドにスコープされる**（`scopeRunToRound` が run 自体を窓で絞るので、
    ビルダー側に第 2 の経路を作らない）。ヘッダに窓を明示し、全体に戻すリンクを出す。
    **例外は run 終端の 3 表**（GMX 建玉 / Aave 口座 / reserve）で、これは run 終了時の 1 断面なので
    タイトルに "at the run's final block" と書く。ラウンド別 volume の合計が run 全体より小さいのは
    正しい（scorer が末尾の端数エポックを落とすため、最終境界より後のブロックはどのラウンドにも属さない）
  - **agent の建玉は全 venue 分が `market.json` に入る**（`gmxPositionsAtEnd` / `aaveAccountsAtEnd` /
    `lstPositionsAtEnd` / `liquityPositionsAtEnd`）。**以前は GMX だけを見ていたので、run 中ずっと
    ステークや借入だけしていた agent は空表になり「壊れている」と見分けがつかなかった**。表は perp 形
    ではなく venue / kind / size / **何に対してマークしているか**（entry 価格・償還レート・ICR・HF）/
    detail。本当に建玉ゼロで終わった場合はその旨を文章で出す
  - `/explorer` は Blockscout の接続状態を明示し（indexed 高さ併記 / 落ちていれば起動コマンド）、
    検索が tx hash・block・address・**agent 名**（→ wallet address。Blockscout は名前を知らない）を
    解決して deep link する。Blockscout が無くてもローカル一覧のフィルタとしては効く
- `npm run typecheck` / `npm run test` — 型チェック / ユニットテスト
- `npm run check:strategy` — 戦略コードの cheatcode 静的検査（入口ゲート）
- `npm run check:boundaries` — workspace 依存方向（example → sdk ← core）の検査
- `npm run bundle:agent <id>` — 提出用 zip（runtime + sdk + lib + 対象 agent。ADR 0015 §7）

> **deployer は本 repo 同梱**（`deployer/`。旧 `../eris-app-deployer` を統合）。全 protocol を空の anvil へ deploy する自己完結のサブパッケージ（独自の `package.json` / `foundry.toml`）。初回のみ `cd deployer && npm install && forge build && cp .env.example .env && ./scripts/setup-vendors.sh`。以降は `cd deployer && npm run deploy -- --keep-fresh` で anvil 起動＋全 venue deploy。**焼き直すときは anvil ごと立て直す**（`--keep-fresh` が消すのは deployments.json だけ。全 venue の seed で deployer アカウントは 100 万 ETH のうち ~99.9 万を使うので、同じ anvil に 2 回目を流すと WETH の wrap で `insufficient funds` で落ちる）。`vendor/` の重いクローン（gmx-src/curve-src/twocrypto-src）は git 管理外で `setup-vendors.sh` が再現する。

> 評価・採点・可視化系コマンド（`sim` 同期ラウンド / `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`）は撤去済み。run は `sim:realtime` 一本。run 後の解析は `runs/<id>/` の `summary.json` / `events.jsonl` / `blocks.csv` / `market.json`（venue 別価格・depth・GMX OI・Aave 残高・tx notional。採点には不使用の報告用 = issue #63 Phase 2）を直接読む。可視化は `npm run dashboard`（`dashboard/` workspace。run picker で run を選ぶ。seed データに戻すには `VITE_DATA_PROVIDER=seed`）。

### 市場ストレスイベント（spike/crash + Aave 清算。ADR 0009。既定 off）

OU の base price はそのまま進め、その上に **SEED 由来でランダム化した決定論オーバーレイ**（`core/src/realtime/events.ts` `EventSchedule`）を重ねて effective price を導出する。effective が PriceFeed・Aave WETH オラクル・GMX・採点へ一貫伝播し、窓外では β≈0 を保つ（ADR 0007 を毀損しない）。清算を成立させる **seed 由来 victim 群**（採点対象外）を建てる。`config/local.yaml` の `stress:` セクションで指定:

- `stress.events` — イベント配列（**値でなくレンジ**を与え過学習を抑制）。YAML 配列で書ける（例: `- { type: crash, magnitudeRange: [0.12, 0.16], windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }`）。`spike`/`crash` の台形（ramp→hold→decay）。要 `run.blocks>0`
- `liquidityPull`（issue #52。uniswap / balancer / curve・**ローカルデプロイ専用**）— 同じ台形で**プールの depth を引き抜き、窓が閉じたら戻す**。`venue:` 省略で**有効な全 venue**（1 つだけ薄くしても執行が他所へ移るだけ。narrowing が opt-in）。magnitude は「抜く割合」（1.0 は禁止＝板が消えると全 swap が revert して「薄い板」でなく「停止」になる）。価格 overlay ではなく coordinator が毎ブロック**目標 depth へ reconcile** する（一撃 removal だと dropped block で取り残される。`pointEventsAt` が同じ理由で一度壊れた）。**両側比例**で抜くので mid は動かず無リスク裁定は開かない。環境が seed した LP（deployer = anvil account 0）を動かすので、ロスターが `AGENT0_PRIVATE_KEY` を使っていると nonce 衝突で fail-fast。fork では seed した LP が存在しないので同じく fail-fast
- **`cexDrift` / `flowTrend`**（issue #56）— **run 全体の config だった 2 レジームを窓イベント化したもの**。
  連続経済では「run 全体がドリフトしている週」を注入できない（週は 1 本で、その中に複数のエピソードが
  非公開スケジュールで入る）。`cexDrift` は**価格の walk 自体**を変える（drift を足し `kappaMultRange` で
  平均回帰を弱める。overlay と違い窓が閉じても価格は戻らない = ドリフトの意味）。`flowTrend` は
  uninformed フローを窓の間だけ傾ける（`magnitudeRange` = サイズ倍率、`trendCorrelation` /
  `persistBlocks` は窓が開いている間フル適用。「ramp 中は相関 0.5」は弱いレジームではなく別のレジーム）。
  較正元は `config/regimes/cex-drift.yaml`（drift 0.0015 / kappa 0.004 = 既定 0.02 の 0.2 倍）と
  `config/regimes/informed-flow.yaml`（サイズ 3x / persist 12 / correlation 1.0）。**単一種のイベントで
  埋めた週は特定の戦略にしか仕事を作らない**（実測: depeg だけの週では venue-arb が 5 seed 中 3 本で
  無取引 = `docs/scoring-metric-measurements.md`）
- **`persist: true`**（depeg / eusdDepeg）/ **`repriceAnchor: true`**（cexDrift）— **戻さない**（issue #56）。
  既定では窓が閉じると環境が買い戻し、OU も初期 anchor へ引き戻すので、**どの価格変動も一時的**になる。
  すると「par に戻るか」の答えが常に yes になり、粘る戦略が判断ではなく構造で勝つ。`persist` は水準を
  run の最後まで保持（`decayBlocks: 0` 必須。decay を黙って無視しないため fail-fast）、`repriceAnchor` は
  OU の anchor をドリフト分だけ動かして新しい水準を常態にする。**teardown の買い戻しは残る**
  （起動チェックがデペグ済みプールを拒否するので、次の run が始められなくなる。最終採点ブロックより後）
- **`alignWith: <type>`** — 窓の開始位置を他イベントと共有する。**同じ `windowFrac` レンジでも draw は独立**なので、360 ブロック run では crash と liquidityPull が平均 ~160 ブロック離れて落ちる。「gap の最中に板が薄い」は組み合わせの性質なので明示が要る（`config/regimes/crash.yaml` が使用例）
- `stress.victimCount`(既定 0=無効) / `stress.victimHf0`(既定 1.10) / `stress.victimWethWei`(victim 1 体の supply)。**較正の連動**: 建てるには `HF0 ≳ LT/(0.97·LTV)`（実測 Arbitrum WETH の LT=0.84/LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くため fail-fast）。割るには crash magnitude `m > (HF0−1)/HF0`（HF0=1.10 なら m>9.1% → 例の [0.12,0.16] で確実に割れる）。breach 不能な設定は `stress_calibration_warning` を emit。borrow がサイレント revert したら setup で fail-fast(debt 検証)
- **victim を建てるには fresh state 必須**（soft-reset だと前 run の victim ポジが残留して HF が壊れる。未満は fail-fast）: fork は full re-fork（`ARB_RPC_URL` 設定 + `ERIS_SKIP_RESET` 不可）、ローカルデプロイは resetFork の snapshot/revert クリーン断面で満たす（ADR 0016。backtest で実証済み）。ローカルでは victim を建てる前に Aave オラクルを初期 fair price へ較正する（fork の「オラクル≈実勢≈fair0」が成立しないため。coordinator が自動実行）
- stress run（events かつ `ERIS_RUN_BLOCKS>0`）は**時間制限を自動無効化**しブロック数で終了する（`ERIS_RUN_SECONDS` が先に切れて crash 窓へ到達しない事故を回避。override は `stress_run_time_limit_disabled` で記録）
- coordinator は `stress_schedule` / `stress_victim_hf` / `stress_liquidation` / `stress_liquidity_pull`（+ `_setup` / `_failed`）/ `stress_liquidity_restored`（残差が閾値超なら `_incomplete`）を events.jsonl へ emit する。depth の帰属は `stress_liquidity_pull` の `poolLiquidityBefore`（実測）と `targetLiquidity` を読む。liquidator agent には victim アドレスを `ERIS_LIQUIDATION_VICTIMS` で配布する。清算の帰属は agent ログの `liquidationCall`(rawTx) を一次情報にする（events.jsonl を直接読んで解析する。旧 stress-report ツールは撤去済み）

### LST venue（wstETH 風 vault + LST/WETH 二次市場。issue #38 Phase 1。既定 off・**ローカルデプロイ専用**）

利回りで償還レートが上がる非 rebasing の LST（`deployer/contracts/MockLSTVault.sol`）と、その二次市場
（既存 stableswap-ng factory 上の LST/WETH plain pool）。**同じ資産に価格が 2 つある**のが本質:
`redemptionRateWeth`（vault が負う par。ただし出金キュー `withdrawalDelayBlocks` 待ち）と
`marketPriceWeth`（プールが今払う額。discount 付き）。observation は両方 + `discountBps` /
`yieldPerBlockBps` / キュー長 / 自分サイズでの `instantExitWethWei` / pending を別々に出す。

- **Arbitrum に対応物が無い**（vault は自作）ので fork では使えない。`run.protocols` に `lst` を入れて
  ローカルデプロイでないと起動時 fail-fast。**`config/example.yaml` の既定ロスターに入っている**
  （`cd deployer && npm run deploy -- --keep-fresh` → `npm run gen:local-constants` → `npm run sim:realtime`）。
  LST 単独で見たいときは競合参加者と較正ノブを明示した `config/lst.yaml`
- **利回りは EVM 時間でなく経済クロック**（`lst.simulatedSecondsPerBlock` / `lst.apyBps`。既定 1 block=1h・3%/yr
  = Aave WETH supply と同オーダー。速すぎると他 venue が無意味になる）。原資は事前投入 reward reserve に上限され、
  `accrueRewards()` は permissionless（額はブロック数の純関数なので誰が叩いても同じ）。coordinator は毎ブロック
  oracle tx と**同じ admin nonce の直列**で叩く（並列にすると nonce 衝突でレートが凍る）
- **プールの rate oracle 配線が要**（`stEthPerToken()` を asset_type=1 で登録）。未配線だとレート上昇が全員に開かれた
  無リスク裁定になる（ADR 0007 を毀損）。deploy 時 assert + 起動時 `lst_setup` で乖離 200bps 超は fail-fast
- **マークが 2 本ある**（`sdk/src/protocols/lst.ts`）。**採点が合計するのは `valueUsdc` = face value**
  （`shareAssets + claimable + reachable + unreachable` × WETH fair = vault が負う par）。
  `realizableWethWei`（「今プールで売った額」と「run 終了までに finalize するキューの par」の**良い方**）は
  `liquidatableValueUsdc` に入り、**マークと差が出た agent だけ報告される診断値**。run 終了後にしか claim
  できない pending は realizable 側からは外れて `reason:"unrealizable"` で `scoring_unpriced_holdings` に
  報告されるが、**採点側の par には含まれている**。#41 の staged-read インターフェース
  （`valueAtBlock` / `liquidatableValueUsdc` / `ValuationContext.horizonBlock`）の最初の消費者。
  **どちらを採点に使うかは未決**: #38 の意図は realizable、現行実装は par（ADR 0019 §3 が採点の基礎に
  「通常の live mark」を選んだ結果でもある）。`lst` が競技セットに入る前に決める
- **Phase 2（選択を非自明にする）実装済み**。`config/lst.yaml` の `lst:` / `stress:` に較正例:
  - **APY 変動** — `lst.apyRangeBps` + `apyStepBlocks` で seed 由来 Rng（独立 salt）から N ブロックごとに再サンプル
    → coordinator が `setRewardRate`。固定利回りだと「block 0 で全ステーク」が恒久最適になるため
  - **キュー混雑 + サイズ依存** — vault の finalize をスループット律速に（`queueThroughputWeiPerBlock`）。
    `claimableAt = max(floor, queueDrainBlock) + ceil(assets/throughput)` = 大口ほど待ち、先客がいるほど待つ。
    観測は実効待ちを `estimatedQueueDelayBlocks`（自分の全保有）と `queueDelayPerWethBlocks`（限界 1 WETH）で分けて出す。
    **採点も実効待ちを使う**（floor で判定すると完了不能な exit を par 評価してしまう）
  - **`lstSlash`** — ADR 0009 と同じレンジ config で `stress.events` に書ける点イベント。1 ブロックで rate を恒久的に下げる。
    **discount は開かない**（プールが rate oracle 追随でリプライスする＝oracle が正しく効いている証拠）。
    slash は「保有者が損をする」リスクであって裁定機会ではない。よって magnitude は利回りスケールで較正する
    （70 ブロック run の利回り ~3-8bps に対し 10-30bps。最初に試した 100-300bps は利回りの 15 倍でステーク自体が常に負けになった）
- **Phase 3（レバレッジ）実装済み**。`run.protocols` に `aave` を足すと有効:
  - deployer が LST を **Aave の担保専用 reserve** として登録（`registerLstReserve`。LTV 70% / LT 75% /
    bonus 7.5%。**borrow は無効**＝現実の LST 上場と同じで、狙いは「LST を担保に ETH を借りる」レバステーキング）。
    Aave 自身の同名 reserve から clone できないため **LTV/LT は明示指定**（issue #38 が指摘した通り）。
    rate strategy のみ WETH から借用
  - **価格は WETH × 償還レート**。専用 MockAggregator を持ち、`sdk/src/protocols/oracles.ts` が
    他の全オラクルと同じ 3 経路（mined / mempool / storage）で毎ブロック書く。よって **1 ブロック遅れ**を継承し、
    slash はまず vault に効き、次ブロックで HF に届く = liquidation cascade の起点
  - `aaveSupply`/`aaveWithdraw` の asset に `"LST"` を指定可能（`TokenKind` に `"lst"` を追加し、
    scorer の spot 掃引から外して二重計上を防いでいる。評価は Aave の totalCollateralBase 経由）
  - `lst-carry` は **`ERIS_LST_LEVERAGE_TARGET_HF` で opt-in**（既定 0=off）。ループは
    stake→collateralize→borrow→stake で、目標 HF に**着地する**サイズだけ借りる（headroom 基準で借りると
    目標も下限も突き抜けて borrow/repay が振動する: 実測 24/22 → 2/0）。HF が下限を割ったら他の何より先に返済。
    prompt 版は spot に専念（LLM に env の opt-in は効かないため、手を出さないよう明記）
  - 市場側の検証は `test/lstLeverage.test.ts`（要 `ERIS_LOCAL_DEPLOY=1` + ローカルデプロイ。実チェーンで
    listing → ETH 借入 → slash 後も HF 不変(=oracle lag) → oracle 更新で HF 低下 を検査。CI では skip）
- **USDC 建て採点では LST 保有戦略は構造的に β で不利**（実測: noop 0 > lst-carry −203 > lst-carry-wide −233、
  一方で WETH を持たない venue-arb は +115）。alphaUsdc は free inventory の β しか除去せず、
  LST ポジションは live mark のため。ETH 建て採点（DAT 型）が issue #38 の motivation で follow-on

### CDP stablecoin venue（Liquity V1 フォーク = eUSD。issue #39。既定 off・**ローカルデプロイ専用**）

Liquity V1 の core を**無改変**でフォークした CDP（`deployer/src/protocols/liquity.ts`）。Recovery Mode・
再分配・sorted list・2 本の動的手数料がそのまま入っているので、他 venue に無い skill が 4 つ増える:

- **redemption arb** — eUSD は常に「最もリスクの高い Trove に対して $1 分の担保」と交換できる。よって
  eUSD/USDC プールのディスカウントは**プロトコルが強制する価格に対する乖離**であって価格予想ではない（ADR 0007 の α 方向）
- **Stability Pool** — eUSD を預けて清算債務を吸収し担保を割引で受け取る
- **Recovery Mode** — system TCR が CCR(150%) を割ると清算閾値が MCR でなくなり、**その時点の TCR** を
  下回る Trove が清算対象になる（SP がその債務を全額吸収できる場合のみ。押収は債務の 110% で頭打ちで、
  余剰は借り手が claim できる）。全員の線が同時に動くのが Aave の per-position HF と対照的
- **sorted list 上の位置** — 償還は最下位 ICR から walk するので、借り手は「自分の前にどれだけ債務があるか」を守る

ours なのは 2 つだけ（core は無改変）:
- `LiquityPriceFeedAdapter` — Liquity は wiring 後に ownership を renounce するのでオラクルアドレスは永久固定。
  一方 run は毎回新しい PriceFeed を deploy するので、その間に挟んで admin key で毎 run 差し替える
- `LiquityRedemptionHelper` — **部分償還のヒントは実行時価格に依存する**（`_redeemCollateralFromTrove` が
  執行価格から NICR を再計算してヒントと一致しなければ partial を cancel）。環境はブロック毎にオラクルを
  書き、しかも agent より先に入るので、オフチェーンで計算したヒントは構造的に必ず陳腐化する
  （venue の初回 live run で全償還が `Unable to redeem any amount` で revert して判明）。helper は
  `fetchPrice()` で価格を確定させた同一 tx 内でヒントを計算する。periphery であって core の改変ではない

- **eUSD は TOKENS レジストリに入れない**……**だったが issue #27 (b) で昇格した**。外していた理由は
  「レジストリが stable を $1 で値付ける」だけで、それが消えたため。今は**市場価格 stable**（下の節）で、
  価格の所有者は共通 probe = `sdk/src/stables.ts`。**spot の eUSD 残高は scorer の spot 掃引が値付け、
  liquity アダプタは値付けない**（二重計上の回避）。アダプタに残るのは Trove と Stability Pool で、
  realizable は自分サイズの get_dy、債務は get_dx で買い戻しコスト。gas compensation 200 eUSD は
  借り手の負債ではないので差し引く。ICR<100% の Trove は 0 で clamp（担保を捨てて歩き去れる = CDP の
  実際の性質）
- **担保は native ETH**（core が `msg.value` で受ける）。action 側は WETH wei 建てで、`buildTxs` が
  `WETH.withdraw` を前置する。ただし**ガスと同じ残高**なので、全部突っ込むと閉じる tx すら送れなくなる。
  observation に `ethBalanceWei` / `suggestedGasReserveWei` を出すが**強制はしない**（self-stranding は正当な負け）
- action は 8 つ: `liquityOpenTrove` / `liquityAdjustTrove` / `liquityCloseTrove` / `liquityRedeem` /
  `liquityProvideToSP` / `liquityWithdrawFromSP` / `liquityLiquidate` + `liquitySwapEusd`。
  最後の 1 つは issue #39 の列挙には無いが、**venue 自身の α（デペグを買って償還する）が届かなくなる**ため追加
- **`eusdDepeg` ストレスイベント**（`stress.events`）— プールは par で seed されるので、放っておくと
  redemption arb は「何もしないのが正解」になる。環境（deployer アカウント = genesis Trove の余剰 eUSD 保有者）が
  窓の間だけ eUSD を売り、閉じたら買い戻す。liquidityPull と同じ**毎ブロック目標へ reconcile** 方式
  （一撃だと dropped block で取り残される）。magnitude は「プールの seeded eUSD depth の何割を売ったか」
- **較正**（実測。100k/100k・A=100 のプール）: 40k 売却で 114bps / 50k で 175bps / 60k で 282bps。
  償還手数料 floor 50bps + 償還 ETH を USDC に戻す ~30bps を超えて初めて α になる。
  プールの A は 2000 ではなく **100**（A=2000 だと半分売っても 4.4bps しか動かず、償還手数料を永久に超えない）。
  eUSD 供給 250k に対し baseRate は 5k 償還ごとに約 +100bps 上がるので、**先に償還した者が後続の価格を決める**
- coordinator は `liquity_setup`（オラクル差し替えと drift 検証。Recovery Mode 開幕やデペグ済みチェーンは fail-fast）/
  `liquity_block`（毎ブロックの peg・TCR・手数料・最下位 ICR）/ `stress_eusd_depeg`（+ `_setup` / `_capped` /
  `_failed` / `_restored`）を emit する
- **オラクル順序の実測**（issue #39 の Open point「清算は Aave より順序に敏感か」への回答）: 敏感だが
  **特別扱いは不要**。実測（`config/regimes/liquity-crash.yaml`, seed 501）では、Trove が MCR を割った
  ブロック 982 → agent が観測した 983（観測は 1 ブロック遅れ）→ 清算が着弾した 984 で **2 ブロック遅延**。
  内訳は「観測遅れ 1 + mempool 1」で、これは全 venue 共通。**部分償還のヒントと違い、`liquidate()` には
  実行時に一致しなければならない値が無い**（執行価格で ICR を再判定するだけ）ので、価格が戻れば単に
  revert して gas を捨てるだけ＝構造的な破綻ではない。よって helper のような仕組みは清算側には不要
- 参照 agent は 3 体: `redemption-arb`（α 側）/ `trove-manager`（借り手側。清算・償還・Recovery Mode に
  対する防御）/ `sp-underwriter`（Stability Pool で清算を吸収し、自分で `liquidate` を叩いて担保を取る）。
  借り手の防御が効くかは**借りた eUSD を使ったかどうか**で決まる（`ERIS_TROVE_SPEND_DEBT`）。実測で
  200% 保持組は無傷、125% で全額 post して eUSD を売った組は清算され −13,140（担保 20 ETH を失い USDC を残す）
- **Recovery Mode は現状の較正では到達不能**（実測: seed 501 で最小 TCR 2.244 対 CCR 1.5）。genesis Trove
  が 250 ETH / 250k eUSD（300%）で TCR を支配するため。到達させるには system 債務を約 3 倍にする必要があり、
  それは償還手数料カーブ（供給に反比例。250k で 5k 償還あたり +100bps → 700k なら +36bps）と SP の相対深度
  （RM の清算は SP が債務を全額吸収できる場合のみ成立）を必ず薄める。**issue #59** に分離
- **LQTY は意図どおり「値付けしないが見える」**: SP 預入で LQTY gain が付き、run 後に
  `scoring_unpriced_holdings` に `erc20-unaccounted` として 61.3 LQTY が報告された（黙って 0 にしていない）
- 設定例は `config/liquity.yaml`、レジームは `config/regimes/liquity.yaml`（α 側）と
  `config/regimes/liquity-crash.yaml`（借り手 / 引受側）、参照 agent は
  `example/agents/redemption-arb/`（`agent.ts` + `prompt.md`）。issue #39 は「agent.ts と prompt.md を
  両方積め」と書いているが、その理由（既定ロスターが prompt モード = LLM が毎判断する）は ADR 0018 で
  消えている。今の prompt.md は改訂方針であって毎判断プロンプトではない

### 市場価格 stable（レジストリの stable を $1 断定でなく市場から値付ける。issue #27）

**「stable = $1」はコードがそう書いていたから**だった。`chain.ts` が active stable を全部足して
`usdcUnits` 1 本に潰し、`valuation.ts` が `kind === "stable"` を無条件に 1 と値付けていたので、
デペグした stable も par で採点されていた（#39 が eUSD をレジストリの**外**に置いて避けていた
phantom value そのもの）。issue #27 でこれを 3 段階で外した:

1. **観測に内訳を出す** — `obs.balances.stables[<symbol>] = {token, decimals, balance, priceUsdc,
   marketQuoted}`。`marketQuoted: false` は「市場が答えなかったので par を仮置きした」で、
   **`priceUsdc: 1` を「ペグが保たれている」と読んではいけない**
2. **`usdcUnits` を native USDC だけに narrow** — 9 箇所の参加者向け用途は全部**予算**であって評価では
   ない（評価は `inventory.valueUsdc`）。合計値は予算として元々間違っていた（USDT は USDC プールで
   使えないし、funding は stable ごとに同額を配るので実際に使える額の約 2 倍を表示していた）
3. **market から値付ける**（`sdk/src/stables.ts`）— **両側の executable probe の幾何平均**
   `sqrt(sell × buy)`（片側だけだと売り側に張り付いて過小評価する。LST / Liquity と同じ規律）。
   両側とも固定 notional なので**1 stage で済み**、採点断面の 1 multicall に相乗りできる。
   quote が返らなければ **par に落として `par-fallback` で報告**（黙って par が最悪、黙って 0 は
   「100% ディスカウント = 無限の裁定」に読めてもっと悪い）

- **USDC は numéraire で $1 固定**（issue #27 "Settled"）。全 metric が USDC 建てなので、ここを
  浮かせると過去 run の数字の意味が変わる。`marketPricedStables()` は USDC の leg を無視する
- **market を持つ stable は funding で配らない**（`fundWallet` は par stable にだけ配る）。cheatcode で
  eUSD を湧かせるのは Trove が発行していない stablecoin を流通させることだし、これから割れる stable を
  全員に配ると損が「誰も選んでいないポジションの β」になる。**買って初めて持てる**のがこの regime の要
- **α でも live mark**（base の fair と違い、peg の乖離は protocol が強制する価格に対する dislocation で、
  それを閉じるのが venue の存在理由。固定参照で評価すると測りたいものが打ち消える）
- `STABLE_MARKET_LEGS`（`sdk/src/constants.ts`）が「どの stable がどのプールで値付くか」の単一ソース。
  leg は `venue` を持ち、**その protocol が有効な run にだけ**その stable が入る（sweep されるが取引
  できない stable は無い方がまし）。eUSD → `liquity` / DAI → `curve`
- **eUSD はレジストリに昇格**（(b)）。#39 が外していた理由（レジストリが stable を par で値付ける）は
  消えたので、**価格の所有権を移した**（二重計上の回避 = `TokenKind: "lst"` と同じ論点）。
  liquity アダプタは spot eUSD 残高を**もう値付けない**（scorer の spot sweep が値付ける）。Trove の
  債務と Stability Pool 預入は venue のものとして残り、価格は `ctx.stablePrices()` から読む
- **DAI が 2 つ目の市場価格 stable**（(c)）。deployer の USDC/DAI stableswap-ng plain pool（100k/100k）を
  使う。**A は 2000 → 100**（#39 と同じ較正: A=2000 だと半分売っても 4.4bps しか動かず、永久に
  コストを超えない）。eUSD と違い**償還フロアが無い**ので、ディスカウントは「戻ると信じるかどうか」で
  あって行使できる請求権ではない = 別のスキル
- **`stableSwap` action**（curve アダプタ所有。プールが Curve stableswap-ng だから）—
  `{type, stable, tokenIn, amountIn, slippageBps?}`。無いとデペグは「見えるだけ」になる
  （#39 が `liquitySwapEusd` を足したのと同じ理由）。**per-round 上限は USDC の 6 decimals 建てなので
  18 decimals の stable では換算が要る**（実測でこれを忘れると sell が毎回 reject され、買いだけ通って
  「閉じられないポジションの含み益」になる: 42 reject / 6 accept）
- **`depeg` ストレスイベント**（`stress.events`。`stable:` 必須）— 環境が窓の間だけその stable を
  プールへ売り、閉じたら買い戻す。機構は `core/src/realtime/stableDepeg.ts` に共通化してあり、
  `eusdDepeg` も同じ実装を通る（イベント名は #39 の `stress_eusd_depeg*` のまま。他の stable は
  `stress_depeg*` + payload の `stable`）。**毎ブロック目標へ reconcile**（一撃だと dropped block で
  取り残される）で、売却量はチェーンから読み直す（revert しても窓がずれない）
- Aave の aggregator にも伝播する（`sdk/src/protocols/oracles.ts`。3 経路すべて）。ただし
  **今どの market-priced stable も Aave reserve ではない**ので現状は no-op で、listing した日に効く
- レジームは `config/regimes/depeg.yaml`（公式セット入り = ADR 0017 の 7 本目）、参照 agent は
  `example/agents/peg-arb/`。実測（seed 701）: 環境が depth の 59% を売って最大 89.5bps のディスカウント、
  peg-arb +139.6 / peg-arb-eager +195.7 / noop 0。**買い手が反対側を取ったぶん、環境が買い戻すと
  プールは stable 不足になって par を超える**（裁定側が解消できていれば −6bps 程度で収まるが、
  解消できないと大きく行き過ぎる。上限バグで sell が全 reject された run では −143bps まで振れ、
  「閉じられないポジションの含み益」が +439 と表示された）

実時間化（ADR 0005）の前提: **SEED(=regime) は市場条件のラベル**で価格パスは再現可能だが、tx タイミング/着順は非決定 → 同一 regime でも結果はぶれる。run 長は `ERIS_RUN_BLOCKS` 固定で揃える。run の比較が要るときは同一 config を複数回回してサンプルを貯め、`runs/<id>/summary.json` を集計する（旧 evaluate/gate は撤去済み）。

## アーキテクチャ（環境とエージェント実行の分離。ADR 0006 / ADR 0015）

```
環境プロセス（core/src/realtime/coordinator.ts = 環境デーモン + 採点者）   agent プロセス × N（完全独立）
  ・anvil ライフサイクル（fork/setup/interval mining）                ・spawn は一律 example/agents/runtime/bot.ts
  ・fair price 生成(Rng(seed)) → PriceFeed/oracle 更新 tx を毎ブロック書込   （agent ディレクトリは env ERIS_AGENT_DIR）
  ・flow bot 注文の relay 送信（市場を動かす）                        ・env で受領: RPC URL / 自分の秘密鍵 /
  ・GMX keeper（注文執行）                                             PriceFeed アドレス / runId・ログ出力先
  ・採点: run 後に歴史ブロック読取で価値系列を一括再構成               ・runtime/read.ts が毎ブロック観測を再構成
         └──────────── 同じ mempool。ブロック内順序は anvil --order fees ・runtime/send.ts が署名・直接送信（nonce 自己管理）
```

- **fair price はオンチェーン配布**（`contracts/PriceFeed.sol`。読取は `sdk/src/priceFeed.ts`、書込は
  `core/src/realtime/priceFeed.ts`）。書込 tx は次ブロック着弾なので情報は 1 ブロック遅れる（全員等しく作用。仕様）。
- **採点は run 後再構成**（`core/src/realtime/reconstruct.ts`）: blockNumber 指定の Multicall3 で全 agent 同一断面の
  価値系列を events.jsonl に observation 形で書く（`runs/<id>/summary.json` に集計）。
  resetFork で歴史が消えるため**次 run の前に必ず再構成を終える**（anvil の保持深度 ~1,050 ブロックに注意）。
- **ルール執行は事後検出**（`core/src/postRunCheck.ts`）: blocks.csv（fee はチェーン上の tx フィールド由来）から
  fee 上限超過を検査し違反 run を `violations` に記録。入口側は `npm run check:strategy`
  （cheatcode 静的検査）で戦略コードを通す。
- **orderflow は独立プロセス**（relay のまま = 環境側の市場機構）。生成ロジックは `core/src/flow/logic.ts`（純粋関数）、
  bot 本体は `core/src/flow/market-maker.ts`。bot は自前 `Rng(ERIS_FLOW_SEED)` で決定論的に動く。
  aave flow の reserve は環境が `readAaveFlowReserves` で読んで渡す。
- protocol アダプタ（`sdk/src/protocols/*.ts`）は `readState`/`observe`/`buildTxs`/`valueUsdc` 等を実装。
  環境の採点と agent runtime の観測再構成が同じアダプタ・同じ `observationFor`（`sdk/src/observation.ts`）を使う。

## エージェント行動ログ

各 agent は runtime が渡す `ctx.log`（`example/agents/runtime/agentLog.ts`）で
`runs/<runId>/agents/<agentId>.jsonl` に毎ラウンドの判断（`reason` / `signals` / `state`）を残す。
runtime/send.ts が同じファイルに mempool 活動（`kind:"mempool"`: submitted / submit_failed /
rejected）を自己申告で追記する（coordinator が submitted を数えられなくなる穴を塞ぐ。ADR 0006 §5）。
出力先は coordinator が渡す env `ERIS_RUN_DIR` / `ERIS_AGENT_ID` で決まる。run 後の診断はこれを一次情報にする。
自己改善型は `ERIS_IMPROVE_LOG_CALLS: "1"`（ロスターの env）で LLM との生の対話（system 全文・送信
messages・生応答・エラー）を `agents/<agentId>.llm.jsonl` に残せる（opt-in。プロンプト調整の一次情報）。

## spot EC2 で重い run を回す（ローカル逼迫の回避。spot skills）

ローカルの CPU/メモリが逼迫するときは、**golden AMI の spot EC2** に run を投げる。ローカルデプロイ前提（fork 不要）で
自己完結し、外部依存は LLM(ollama) egress のみ。全 protocol を deploy 済みの anvil state を AMI に焼いてあり、
launch 時は `anvil --load-state` で全 5 venue を ~10 秒復元 → install/deploy なしで run（起動 ~3 分・full venue + LLM が安定 green）。
SSH 一本で結果を手元に回収（S3/IAM ロール不要）。AWS は `eris` profile（account `075096050160`）固定。スクリプトは
user-global の spot skills（`~/.claude/skills/spot-{run,bake,ops}/scripts/`）に同梱（repo の `infra/spot/` から移設）。
poc repo ルートで叩く（スクリプトは `$PWD` を poc とみなす。別パスは `ERIS_POC_DIR`）。設計と学びは memory `spot-ec2-runner`。
**注: ADR 0015 の workspace 化で npm install の対象・パス前提が変わったため、次回 spot 利用時は AMI の焼き直し（/spot-bake）が必要。**

- **`/spot-run`** — golden AMI で run を回し結果を回収（日常ドライバ）。`ERIS_SPOT_AMI=latest` で最新 AMI 自動解決。
- **`/spot-bake`** — 新しい golden AMI を焼く（poc 依存追加 / deployer・constants 変更時。agent config だけなら不要）。~35 分。
- **`/spot-ops`** — 初回セットアップ（鍵 + SG + IAM）/ 状態確認 / 掃除（残骸インスタンス・古い AMI・IP 再許可）。
