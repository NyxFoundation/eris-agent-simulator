[← 目次](README.md) ｜ [← 06 採点](06-scoring.md) ｜ [08 成果物 →](08-artifacts.md)

# 07. 設定

出典 `sdk/src/runConfig.ts`（スキーマ）、`sdk/src/config.ts`（既定値と解決）、`core/src/runConfig.ts`（ロスター・CLI・環境側の拡張）、`core/src/config.ts`（ロスター検証）。

## 7.1 原則

**run の設定値とエージェントロスターは `config/local.yaml` 一本で管理する**（ADR 0013）。env からの設定読み取りは廃止済み。

env に残るのは 3 分類のみ（`sdk/src/runConfig.ts:9-13`）：

| 分類 | 例 |
|---|---|
| **秘密情報** | `ARB_RPC_URL` / `ANVIL_RPC_URL` / `*_PRIVATE_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY` |
| **エージェント IPC** | `ERIS_AGENT_*`（coordinator が子プロセスへ渡す） |
| **設定ファイル選択** | `ERIS_CONFIG` |

RPC URL や chain id が秘密情報側にあるのは、**それらが regime ではなく deployment に属する**ため。committed な regime YAML が特定の運用者のノードを名指してはならない。

**退役した config env が設定されていると警告する**（`core/src/runConfig.ts:110`）。`ENABLED_PROTOCOLS` / `SEED` / `ERIS_RUN_BLOCKS` / `ERIS_PRICE_*` / `ERIS_AGENT_DIRECT_TX` などは**読まれない**ので、設定したままだと「較正したつもりの黙った no-op」になる。

## 7.2 解決順

```
--config <path>  >  ERIS_CONFIG  >  config/local.yaml  >  config/example.yaml
```

最初に存在したものを使う。1 つも無ければエラー（env へのフォールバックは無い）。`config/example.yaml` は committed な雛形で、これが zero-config の既定になる。

その上に重ねる優先順位：

```
秘密情報 env  <  YAML  <  CLI フラグ  <  プログラム的 override
```

`ERIS_CONFIG` は子プロセスへ伝播するので、**エージェントプロセスは同じ YAML から config を再構築する**（環境とエージェントが同じ設定断面を見る = このローダが sdk にある理由）。

## 7.3 スキーマ

キーは**ネスト lowercase**で、`SCHEMA`（`sdk/src/runConfig.ts:73`）が内部の env 名へ写す。セクションは `run` / `market` / `funding` / `limits` / `flow` / `stress` / `vuln` / `lst` + `agents`。

**未知のキーは警告して無視する**（タイポ検出）。大文字始まりのキーは後方互換のため env 名としてそのまま通す。

### `run`

| キー | 既定 | 意味 |
|---|---|---|
| `seed` | 1 | 市場条件のラベル。価格パスとイベント窓を決める |
| `blocks` | 0 | ブロック数で終了（0 = 無制限） |
| `seconds` | 20 | 実時間で終了 |
| `blockTimeSec` | 2 | ブロック間隔 |
| `protocols` | 全部 | 有効化する venue |
| `economicGas` | false | ガスを経済コスト化（ADR 0011） |
| `localDeploy` | false（雛形は **true**） | ローカルデプロイのアドレス overlay |
| `chainMode` | `anvil` | `anvil` / `external`（[01 §1.5](01-architecture.md)） |
| `chainId` | 定数 | 外部チェーンの id |
| `externalRoleEthWei` | 50 ETH | external で admin/keeper に補填する目標残高 |
| `resetUnit` | `continuous` | world のリセット単位（[02 §2.4](02-runtime.md)） |
| `skipReset` | false | 診断用。前 run のフォークキャッシュを残す |
| `prewarmBlocks` | 0 | 競技前の暖機ブロック数 |
| `scoreEvery` | 1 | equity curve の間引き（**スコア不変**） |
| `epochBlocks` | 12 | 1 エポックのブロック数 |
| `epochSeconds` | 0 | 1 エポックの秒数（`epochBlocks` と併用は throw） |
| `segmentHours` | 0 | 1 セグメントの時間（0 = 単一ディレクトリ） |
| `segmentName` | "" | 期間全体の表示名 |
| `markMedianBlocks` | 5 | G7 の median 窓 |
| `reportDir` | `./runs` | 出力ルート |
| `flashArb` | false | FlashArb コントラクトのデプロイ |
| `localSnapshotFile` | `.local-snapshot` | snapshot id の置き場 |
| `agentTimeoutMs` | 5000 | エージェント応答の待ち時間 |
| `agentsConfig` | `config/example.yaml` | インライン `agents:` が無いときのロスターファイル |
| `agentsDir` | `example/agents` | ディレクトリ規約のルート |
| `readRpcUrl` | `rpcUrl` と同じ | read を replica へ分離する（`ERIS_READ_RPC_URL`） |

### `market`（fair price の OU）

| キー | 既定 | |
|---|---|---|
| `volatility` | 0.004 | 1 ブロックの一様ショック幅 |
| `kappa` | 0.02 | 平均回帰の強さ |
| `drift` | 0 | 方向性 |
| `baseVolatility` / `baseKappa` / `baseDrift` | — | `{WBTC: ...}` 形式の per-base 上書き |

### `funding`

| キー | 既定 | |
|---|---|---|
| `ethWei` | 100 ETH（`economicGas` 時 3 ETH） | エージェントの native 残高（**ガスバッファなし**） |
| `wethWei` | 10 WETH | 初期 WETH |
| `usdcUnits` | 25,000 USDC | 初期 USDC |
| `base` | `{WETH: wethWei}` | 追加 base の初期在庫 |
| `flowEthWei` | 1,000 ETH | flow ウォレットの native |
| `flowWethWei` | 0 | flow ウォレットの WETH |
| `flowBase` | {} | flow ウォレットの追加 base |

**公式レジームは ETH / BTC / USDC のバスケットを配る**（8 WETH + 0.4 WBTC + 25k USDC。issue #54）。当初は USDC-only（`wethWei: "0"`）で初期 β を消していたが（ADR 0017 §4）、**LST vault と Trove は WETH/ETH 建てなので、USDC-only では各戦略の売り側に在庫が無く構造的に死ぬ**ことが分かった。β はベンチマークも同じ配布を持つので M9 からは相殺される — USDC-only が守っていたのは報告値である `netPnlUsdc` の方だった。

USDC-only を維持しているのは **`metric-*` レジームだけ**で、こちらは理由が違う（ADR 0019 §6：エポック系列は live mark なので、配った在庫のボラティリティが全員の `std_e` に乗る）。`scripts/genMetricRegimes.ts` が公式レジームから生成する際に `funding.base` ごと落とす。

雛形（`config/example.yaml`）が WETH を配るのも同じ理由（探索用であり測定用ではない）。

### `limits`

| キー | 既定 | |
|---|---|---|
| `agentWethWei` | 1 WETH | 1 ラウンドの swap 入力上限 |
| `agentUsdcUnits` | 5,000 USDC | 同上 |
| `agentBase` / `lpBase` / `aaveSupplyBase` | `{WETH: ...}` | per-base 上限 |
| `lpWethWei` / `lpUsdcUnits` | 1 WETH / 5,000 USDC | LP 提供 |
| `bundleActions` | 定数 | バンドル要素数 |
| `openPositions` | 10 | LP 建玉数 |
| `gmxSizeUsd` | 50,000 USD | perp サイズ |
| `aaveSupplyWethWei` / `aaveBorrowUsdcUnits` | 5 WETH / 5,000 USDC | Aave |
| `priorityFeeWei` | 0.1 gwei | 既定 priority fee |
| `maxPriorityFeeWei` | 5 gwei | 上限（`economicGas` では実質無制限） |

### `flow`

| キー | 既定 | |
|---|---|---|
| `uninformedMaxWethWei` | 1 WETH | uninformed の 1 件上限 |
| `uninformedCount` | 1 | λ=0 時の固定件数 |
| `uninformedPersistBlocks` | 1 | 方向の持続窓 |
| `uninformedTrendCorrelation` | 0 | 市場共通方向に従う確率 |
| `informedMaxWethWei` | 2 WETH | informed のサイズ基準 |
| `balancerMaxWethWei` / `curveMaxWethWei` | 1 WETH | venue 別 |
| `gmxMaxSizeUsd` | 20,000 USD | |
| `gmxActivityProb` / `gmxMaxBurst` | 0.5 / 2 | legacy モード用 |
| `aaveMaxWethWei` | 2 WETH | |
| `aaveActivityProb` / `aaveActorCount` | 0.5 / 4 | アクタープール |
| `informedArbFeeBps` | **30** | 裁定の手数料帯（0 で無効） |
| `uninformedArrivalRate` / `uninformedSizeSigma` | **0.9 / 1.0** | Poisson 到着 / lognormal サイズ |
| `gmxArrivalRate` / `gmxSizeSigma` | **0.75 / 1.0** | 同上（GMX） |
| `aaveActorSizeSigma` | **1.0** | アクターの担保サイズ分布 |
| `baseMax` | `{WETH: 0}` | 追加 base の AMM フロー上限（0 = そのbaseのフロー無効） |
| `seed` | `run.seed` と同じ | flow bot の Rng |
| `botCommand` / `botArgs` | `node --import tsx core/src/flow/market-maker.ts` | |

> Poisson / lognormal は分散を増やすので、run の比較は**複数 seed の集計**として読む。

### `stress` / `vuln` / `lst`

| キー | 既定 | |
|---|---|---|
| `stress.events` | [] | イベント配列（[04](04-stress-events.md)） |
| `stress.victimCount` / `victimHf0` / `victimWethWei` | 0 / 1.10 / 5 WETH | 清算 victim |
| `vuln.events` / `poolLiquidityUsdcUnits` / `poolFeeBps` / `llm` | [] / 2M USDC / 30 / "0" | 脆弱性イベント（ADR 0014） |
| `lst.simulatedSecondsPerBlock` | 3600 | 経済クロック（1 ブロック = 1 時間） |
| `lst.apyBps` | 300 | 3%/yr |
| `lst.apyRangeBps` / `apyStepBlocks` | — / 10 | APY 変動 |
| `lst.withdrawalDelayBlocks` | 0 | 出金待ちの下限 |
| `lst.queueThroughputWeiPerBlock` | 0（無制限） | キューのスループット |
| `lst.maxDepositWethWei` | 5 WETH | 1 回のステーク上限 |

## 7.4 CLI フラグ

一回限りの上書き（`CLI_ALIAS`、`core/src/runConfig.ts:147`）。

| フラグ | 対応キー |
|---|---|
| `--config <path>` | 設定ファイルの選択 |
| `--seed <N>` | `run.seed` |
| `--blocks <N>` / `--seconds <N>` | `run.blocks` / `run.seconds` |
| `--protocols <csv>` | `run.protocols` |
| `--agents <path>` | `run.agentsConfig` |
| `--economic-gas` | `run.economicGas` |
| `--local-deploy` | `run.localDeploy` |
| `--score-every <N>` | `run.scoreEvery` |
| `--chain-mode <mode>` | `run.chainMode` |

パース形式は `--key value` / `--key=value` / `--flag`（値なしは `"1"`）。

**backtest の `--agents` は実効 regime YAML に書き出されてエージェントプロセスにも伝播する。** coordinator だけに効かせるとエージェントが観測で死ぬ。

## 7.5 ロスター

`agents:` にインラインで書くか、無ければ `run.agentsConfig` のファイルから読む。

```yaml
agents:
  - id: arb-bot                # example/agents/arb-bot/ を runtime/bot.ts が駆動
    wallet: AGENT2_PRIVATE_KEY
  - id: clean-arb-wide         # 同一戦略の複数体は dir で実体ディレクトリを指す
    dir: clean-arb
    wallet: AUTO
    env: { ERIS_ARB_SAFETY_BPS: "150" }   # agent プロセスへ渡す戦略パラメータ
  - id: partner-1              # 外部参加者（環境は起動しない）
    external: true
    address: "0x...."
```

### `AgentSpec` のフィールド

| フィールド | 必須 | 意味 |
|---|---|---|
| `id` | ○ | 一意。ディレクトリ名でもある |
| `dir` | | 実体ディレクトリの上書き（同一戦略の複数体） |
| `wallet` | △ | `AGENT0..6_PRIVATE_KEY` または `AUTO` |
| `address` | △ | 外部参加者のアドレス（`external: true` 必須） |
| `command` / `args` | | 完全自前エージェントの override（`args` は `command` 必須） |
| `env` | | エージェントプロセスへ渡す文字列マップ |
| `description` | | 説明 |
| `baseline` | | **ベンチマーク指定**（[06 §6.4](06-scoring.md)） |
| `external` | | 参加者が自分で動かす登録エントリ |

### 検証（`validateAgentsFile`）

| 検査 | throw する条件 |
|---|---|
| id | 空 / 重複 |
| wallet | 未対応の名前。名前付きウォレットの再利用（**追加のエージェントは `AUTO` を使う**） |
| address | `external` でないのに指定 / 20 バイト hex でない / `wallet` と併用 / 重複 |
| external | `command` / `args` / `dir` / `env` を持つ（**黙殺せず拒否**） |
| env | 文字列以外のキー・値 |

`AUTO` の鍵は `keccak256("auto-wallet:<seed>:<agentId>")` で決定論的に導出する。

**ロスターファイルが存在しない場合の既定**は `noop` / `random` / `simple-rule` の 3 体。

## 7.6 config が触れないもの

| 対象 | 決まる場所 |
|---|---|
| venue のアドレス | `sdk/src/constants.ts`（fork）/ `constants.local.ts`（ローカル、`npm run gen:local-constants` の生成物） |
| チェーンの接続先 | `.env.local` の `ANVIL_RPC_URL` / `CHAIN_ID` / `TREASURY_PRIVATE_KEY` |
| プールの較正（depth / A / 手数料） | `deployer/` |
| アクション語彙 | `sdk/src/action.ts` |

**ローカル ⇄ devnet の切り替えは 2 軸**で、別々の場所にある。**チェーン**（`.env.local` + `--chain-mode external`）と**アドレス**（`DEPLOYMENTS_JSON=<path> npm run gen:local-constants`）。config ファイル自体は共通。**アドレス overlay は同時に 1 つ**なので、deployment を移るたびに再生成が要る。片方だけ動かすと以前は setup の数分後に `Cannot decode zero data ("0x")` と生アドレスが出るだけだったので、**起動時に deployment の有無を実測して落とす**（`deployment_check`。何が無いかと再生成コマンドを出す）。

## 7.7 用途別の設定ファイル

| ファイル | 用途 |
|---|---|
| `config/example.yaml` | committed 雛形（`run.localDeploy: true` 既定） |
| `config/local.yaml` | 実際に使うファイル（gitignore） |
| `config/practice.yaml` | 練習 devnet |
| `config/lst.yaml` | venue 単体の検証（較正ノブを明示） |
| `config/liquity.yaml` | 同上（Liquity）。**`.gitignore` の `config/*.yaml` に掛かっていて repo に入っていない** — clone しても存在しない |
| `config/vuln-test.yaml` | 脆弱性イベント |
| `config/regimes/<name>.yaml` | 公式レジーム（backtest が読む） |
| `config/scenarios/<name>.yaml` | シナリオセット（`{regimes, seeds}` の直積） |
| `config/rosters/` | 差し替え用ロスター |
