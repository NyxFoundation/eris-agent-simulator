[← 目次](README.md) ｜ [← 02 実行モデル](02-runtime.md) ｜ [04 ストレスイベント →](04-stress-events.md)

# 03. 市場環境

環境が市場を動かす経路は 3 つしかない。**fair price の生成と配信**、**orderflow の注文**、**keeper の執行**である。ストレスイベント（[04](04-stress-events.md)）はこのうち前 2 つに乗る。

## 3.1 fair price モデル

### 3.1.1 生成式

出典 `sdk/src/rng.ts:108` `nextFairPrice`。平均回帰（OU 型）の離散更新。

```
shock  = (rng.next() − 0.5) × 2 × volatility
revert = kappa × (anchor − current) / current
next   = max(100, current × (1 + drift + revert + shock))
```

| パラメータ | config キー | 既定 | 意味 |
|---|---|---|---|
| `volatility` | `market.volatility` | 0.004 | 1 ブロックあたりの一様ショック幅 |
| `kappa` | `market.kappa` | 0.02 | anchor への引き戻しの強さ |
| `drift` | `market.drift` | 0 | 一定の方向性 |

per-base の上書きは `market.baseVolatility` / `baseKappa` / `baseDrift`（`{WBTC: ...}` 形式）。

`anchor` は**競技開始時の base fair price**で run 中は固定 — ただし `cexDrift` エピソードは anchor 自体を動かす（§3.1.4）。

**シナリオの乱数は鍵付きストリーム**（ADR 0027。`Rng.fromSeed` = `HMAC-SHA256(K, "eris-rng/v1" ‖ seed ‖ salt ‖ counter)` を 53 bit の [0, 1) に写す）。K は公開セットでは公開鍵 `SHA-256("eris-public-v1")`、ライブ週は運営の秘密鍵（コミットメントを事前に公表し、原本は結果発表後に公開）。`new Rng(x)` は LCG（`state = (1664525·state + 1013904223) mod 2³²`）のままで、シナリオと無関係な用途（agent 側の `ctx.rng`・actor のサイズ）専用。`gaussian()` は Box-Muller、`lognormal(mean, σ)` は `μ = ln(mean) − σ²/2` として期待値を `mean` に一致させる、`poisson(λ)` は Knuth 法。

**run の seed から Rng を作るのは必ず `Rng.fromSeed(seed, salt)`**（文字列 salt は FNV-1a。`sdk/src/rng.ts`。#150 では `new Rng(fmix32(seed ^ salt))` だった）。消費者ごとに salt が違う（価格 `price:<symbol>` / flow `flow` / prewarm `prewarm` / agent runtime `agent-runtime` / LST `LSTY` / vuln `VULN`）。`new Rng(seed)` をそのまま使うと、LCG なので Δ 違いの seed の初回値が a·Δ/2³² しか離れず（seed 1〜200 は全部 [0.236, 0.314)）、以降の各 draw も「Δ 先の seed の同じ draw + 定数 mod 1」になる。salt を XOR するだけでも近い seed は近いまま。実測（修正前）: WETH の最初のショックは seed 1〜200 の全部で −21〜−15bps、WBTC は全部 +29〜+37bps、vuln の最初のイベントの poolCount [4, 6] は全部 4、LST の最初の APY は [100, 900] のうち 513〜592bps。さらに `flow.seed` の既定は run seed なので、**flow bot は価格パスと同じ系列を引いていた**（calm の flow は 1 ラウンド 24 draw 以上 = AMM + GMX だけで数えた下限 なので、遅くとも 16 ラウンド目までに run 全体の 360 ショックを順に消費していた）。数字は `scripts/measureSeedCorrelation.ts`。**2026-09-28（ADR 0027）以前の run とは同じ seed でも realization が違う**

### 3.1.2 なぜ平均回帰なのか

幾何ランダムウォーク＋ドリフトだと **seed ごとにトレンドが乗り、その累積方向性エクスポージャ（β）が PnL を支配して「ランダム取引 ≈ 賢い裁定」になる**（`rng.ts:59-64`、ADR 0003）。平均回帰にして anchor へ引き戻すと run 終了時に価格が出発点近くへ戻り、方向からは儲からなくなる。残るのは「プールと fair の乖離を読む」裁定スキル（α）だけになる。

### 3.1.3 マルチアセット

base ごとに**独立した Rng** を持つ（`priceRngForAsset` = `Rng.fromSeed(seed, "price:<symbol>")`）。WETH も他の base と同じ導出（以前は salt 0 = `Rng(seed)` そのもので、既存 run とのバイト互換のためだったが、上の相関のため捨てた）。

**アセット間相関は 0**（v1）。相関を入れるには共有 Rng に統合する必要があり、そうすると base を足すたびに WETH の消費列が動くので既定では行っていない。

### 3.1.4 base 価格と effective 価格の分離

ADR 0009 §1 の要。

```
baseFair  ← OU で前進（ストレスイベントは触らない。ただし cexDrift は例外）
effective ← baseFair × overlay.wethMult（ストレスイベントの乗算的歪み）
```

窓の外では `overlay = 1` なので β ≈ 0 が保たれる（ADR 0007 を毀損しない）。**effective price が PriceFeed・Aave オラクル・GMX・採点へ一貫して伝播する**。

例外が 2 つある（[04](04-stress-events.md) §4.4）。

- **`cexDrift`** は overlay ではなく**walk 自体**を変える（drift を加算し `kappaMult` で平均回帰を弱める）。overlay だと窓が閉じた瞬間に平均回帰がエピソードを消してしまう。
- **`repriceAnchor`** は anchor を動かし、到達した水準を常態にする。

### 3.1.5 配信経路と 1 ブロック遅延

| 経路 | 対象 | 実装 |
|---|---|---|
| `PriceFeed` コントラクト | 全 base の fair price | `core/src/realtime/priceFeed.ts`、読み取りは `sdk/src/priceFeed.ts` |
| Aave `MockAggregator` | WETH / USDC / 追加 base / 市場価格 stable / LST | `sdk/src/protocols/oracles.ts` |
| GMX `MockOracleProvider` | index market の価格 | `ctx.updateGmxOracle` |
| Liquity `LiquityPriceFeedAdapter` | Trove のマーク価格 | `core/src/realtime/liquity.ts` が run ごとに差し替え |

書き込みには**3 経路**があり、プロファイルで使い分ける（`oracles.ts`）。

| 関数 | 方式 | 使う場面 |
|---|---|---|
| `updateOracles` | `sendAndMine`（同期） | setup 段、prewarm、external の較正 |
| `updateOraclesMempool` | `sendNoMine` + 高 priority fee | 既定プロファイルの毎ブロック |
| `writeAaveOraclesStorage` | `setStorageAt`（cheatcode） | `economicGas` プロファイル（front-run の的を消す） |

**書き込み tx は次ブロックで着弾する**ので、エージェントが観測できるのは 1 ブロック前の値になる。これは全員に等しく作用する仕様であり（[00 §0.5 P2](00-overview.md)）、次の帰結を持つ。

- Aave / Liquity の清算は「価格が動いたブロック → 観測できるブロック（+1）→ 着弾（+1）」で**2 ブロック遅延**する。内訳は観測遅れ 1 + mempool 1 で、全 venue 共通。
- **LST の Aave 価格は `WETH × 償還レート`** で、同じ 1 ブロック遅延を継承する。slash はまず vault に効き、次ブロックで HF に届く = liquidation cascade の起点になる（`oracles.ts:15-25`）。

### 3.1.6 ブロック内の順序

`--order fees` で決まる。**anvil が並べるキーは `maxFeePerGas`**（foundry v1.7.1 `crates/anvil/src/eth/pool/transactions.rs`: `TransactionPriority(tx.max_fee_per_gas())`）で、tip ではない。一方 base fee 0 のチェーンで tx が払うのは min(maxFeePerGas, tip)。**両者が一致するのは maxFeePerGas ≤ maxPriorityFeePerGas のときだけ**なので、参加者の tx にはこれを要求する（手数料ルール、`sdk/src/feeRule.ts`）: 型付き tx は `maxFeePerGas ≤ maxPriorityFeePerGas ≤ 上限`、legacy / 0x01 は `gasPrice ≤ 上限`。RPC ゲートウェイが入口で拒否し、参照ランタイムは両者を等しく署名し、`postRunCheck` が事後に検出する（[11 §11.3](11-invariants.md)）。**このルールが無いと順序は払った額に従わない** — 実測（2026-09-27、anvil 1.7.1 `--order fees --base-fee 0`）で tip 0.1 gwei / maxFeePerGas 7 gwei の tx が、オラクル更新と同じ形の 6/6 gwei の tx より前（txIndex 0）に入り、0.1 gwei/gas しか払わなかった。

`economicGas: false`（ADR 0010）では環境がエージェント上限より高く積むので、**オラクル更新が txIndex 0、keeper がその直下**に固定される（[02 §2.2](02-runtime.md)）。公式・練習の既定の `economicGas: true` では価格は storage 直書きで、追い越す対象の tx が無い。この前提は `npm run check:ordering -- --live` が実測で検証する（どのフィールドで並べているかも。[10 §10.6](10-operations.md)）。

## 3.2 orderflow

### 3.2.1 プロセス構造

flow bot は**独立プロセス**（`core/src/flow/market-maker.ts`）で、生成ロジックは純関数（`core/src/flow/logic.ts`）。

- **bot は RPC を一切触らない。** coordinator が毎ブロック context を stdin へ push し、bot が stdout へ書いた注文行を coordinator が flow ウォレットで署名して mempool へ中継する。
- bot は自前の `flowRng(flow.seed)`（= `Rng.fromSeed(flow.seed, "flow")`。価格パスとは別系列）で決定論的に動く。呼び出し順は coordinator が渡す protocol 順（既定 `uniswap, balancer, curve, gmx, aave`）。
- Aave の reserve 状態は環境が読んで context に載せる（bot は読めないため）。

### 3.2.2 AMM フロー（uniswap / balancer / curve）

`buildAmmFlow`（`logic.ts:247`）。1 venue につき **uninformed（乖離を作る）と informed（乖離を閉じる）の 2 種**を出す。

**uninformed（ノイズトレーダー）**

| 要素 | 規則 | 既定 |
|---|---|---|
| 到着数 | `Poisson(λ)`。λ=0 なら固定 `uninformedCount` 件 | λ = 0.45 |
| サイズ | `lognormal(mean = max×0.5, σ)` を `[2%, clampMult×100%]` に clamp。λ=0 なら `max/20 .. max` の一様 | σ = 1.5、clampMult = 3（公式 regime は 10） |
| 方向 | `persistBlocks > 1` なら `floor(round/persistBlocks)` の窓ごとに `trendBit(flowSeed, window, venue)` で固定（seed を tag ごとの key へハッシュしてから窓を混ぜる。以前は `seed ^ (window+1)` を混ぜていたので seed 100 と 101 が隣の窓を入れ替えただけの同じ方向列になり、1 違いの seed はビットの 56.8% が一致した）。それ以外は毎回 `rng.bool()` | persist = 1 |
| 相関 | `trendCorrelation` の確率で venue 個別のビットではなく**市場共通のビット**に従う | 0 |
| priority fee | `default + [1,50) × 10⁶ wei` | |

`trendCorrelation` が効くのは `persistBlocks > 1` のときだけ（方向が存在しないと相関のしようがない）。venue 個別のビットは**venue 間スプレッド**を作り、市場共通のビットは**市場全体を一方向に押す** — 後者では裁定ではなく「どちら側に付くか」が問われる（ADR 0017 regime 2 = `informed-flow`）。

**informed（裁定側）**

```
rawDeviation = |fair/pool − 1|
if (feeBps > 0 && rawDeviation×10000 <= feeBps)  → 何も出さない（no-arb band）
effectiveDeviation = max(0, rawDeviation − feeBps/10000)
size = informedMax × min(1, effectiveDeviation × 20)
```

`flow.informedArbFeeBps`（既定 30bps）は注文を出す閾値であり、超過した乖離に応じてサイズ・在庫の範囲内で注文する。**残差が 30bps になる保証ではない。** 実際の乖離は板の深さ、noise flow、fair price の変化、着弾時刻で決まる。priority fee は `default + [50,100) × 10⁶ wei` で uninformed より高い。

informed の売りは base 在庫内に制限し、在庫ゼロなら買い自体が fair に近づく機会を待つ。補充のために割高な pool を買う方向へ反転しない。uninformed は在庫不足時に反転することがある。agent と flow の初期資金は別設定である。

WETH 以外の base は `flow.baseMax` が共通上限となる。任意の `flow.baseInformedMax` は Uniswap の informed 上限だけを上書きし、未指定なら共通値を継承、明示的な 0 ならその leg を停止する。公式 12 regime は flow ウォレットに 7.5 WBTC を配り、Uniswap informed 上限を 0.1 WBTC とする。開始 fair（$60,000/$3,000）で 150 WETH の資金・2 WETH の上限と USD 換算額が一致し、他の WBTC 上限は 0.05 のまま。[#124 の実測](../verification/wbtc-residual-124.md)を参照。観測された残差は一定の裁定利益を意味しない。

### 3.2.3 GMX フロー

`buildGmxFlow`（`logic.ts:440`）。

- 件数：`Poisson(λ)`（既定 0.75）。λ=0 なら `Bernoulli(activityProb)` ゲート + `1..maxBurst` の一様バースト
- サイズ：`lognormal(mean = gmxMax×0.025, σ)` を `[0.5%, 10%]` に clamp
- 担保：`sizeUsd/2` を約 2100 USD/ETH で WETH 換算（≒ 2 倍レバレッジ）
- WETH 在庫が足りないブロックは、担保用の USDC→WETH を 1 件だけ出してそのブロックは終わる

### 3.2.4 Aave フロー

実時間の主経路は**アクタープール**（`buildAaveActorsFlow`）。`flow.aaveActorCount` 体の独立アドレスが**永続ポジション**を持ち、各アクターが毎ブロック確率 `flow.aaveActivityProb` で「supply / borrow / repay / withdraw」のいずれかを 1 回行う。1 ブロック内の同時 borrow 数は最大でアクター数（別アドレスなので自然に生じる）。

`flow.aaveActorSizeSigma`（既定 1.0）で各アクターの目標担保が lognormal に散る（大口と小口の混在）。借入は各自の担保の 30% LTV に追随するので、HF の安全性は変わらない。

アクター群には担保 WETH を直接配る（USDC→WETH の準備 swap はスリッページで落ちやすく、担保を確保できないまま借入に到達しない）。担保は非採点の flow ウォレットにあるので、エージェントの β には影響しない。

### 3.2.5 決定論と非決定論

| 決定論的 | 非決定論的 |
|---|---|
| 価格パス（seed の純関数） | tx の到着タイミング |
| ストレススケジュール（seed の純関数） | ブロック内の着順（手数料が同じ場合） |
| 同じ RNG 状態・context からの flow 生成 | context（価格・在庫）と実際に約定するかどうか |

したがって**同一 seed でも run の結果はぶれる**（[00 §0.5 P3](00-overview.md)）。

## 3.3 venue

`run.protocols` で有効化する。`ProtocolId` は 7 種（`sdk/src/types.ts:15`）。

| id | 実体 | 特徴 | fork | ローカル |
|---|---|---|---|---|
| `uniswap` | Uniswap V3 | 集中流動性。LP 建玉（tokenId）を持てる | ○ | ○ |
| `balancer` | Balancer v2 | weighted pool | ○ | ○ |
| `curve` | Curve（stableswap-ng / twocrypto-ng） | stable ペアと crypto ペア。`stableSwap` の所有者 | ○ | ○ |
| `gmx` | GMX v2 | perp。**keeper の執行が必要**なのでバンドル不可 | ○ | ○ |
| `aave` | Aave v3 | 貸借と清算。HF はオラクル追随 | ○ | ○ |
| `lst` | 自作 vault（wstETH 風）+ LST/WETH 二次市場 | **同じ資産に価格が 2 つある** | **×** | ○ |
| `liquity` | Liquity V1 の無改変フォーク（eUSD） | CDP・Stability Pool・償還・Recovery Mode | **×** | ○ |

`lst` と `liquity` は Arbitrum に対応物が無いため**ローカルデプロイ専用**で、fork で有効化すると起動時 fail-fast する。

### 3.3.1 LST venue が持ち込むもの

**1 つの資産に 2 つの価格がある**こと（`sdk/src/types.ts:460-467`）。

| 価格 | 意味 | 到達手段 |
|---|---|---|
| `redemptionRateWeth` | vault が負う par | 出金キュー待ち |
| `marketPriceWeth` | プールが今払う額 | 即時（ディスカウント付き） |

観測は両方に加えて `discountBps` / `yieldPerBlockBps` / キュー長 / **自分のサイズでの実効待ちブロック数**（`estimatedQueueDelayBlocks`）を別々に出す。利回りはブロックごとに積まれ、1 ブロックを `lst.simulatedSecondsPerBlock` 秒分と数える（既定は `run.blockTimeSec` = Aave・GMX と同じ時計、3%/yr。ADR 0028）。以前の既定 1 block = 1 時間は、利回りが Aave の借入コストの 1,800 倍の速さで積まれる無リスクの利鞘だった。

プールの rate oracle 配線（`stEthPerToken()` を asset_type=1 で登録）が必須で、未配線だとレート上昇が**全員に開かれた無リスク裁定**になる。deploy 時 assert + 起動時 `lst_setup` で乖離 200bps 超なら fail-fast する。

### 3.3.2 Liquity venue が持ち込むもの

`sdk/src/types.ts:551-560` が挙げる 4 つ。

1. **償還裁定** — eUSD は常に「最もリスクの高い Trove に対して $1 分の担保」と交換できる。よってディスカウントは価格予想ではなく**プロトコルが強制する価格に対する乖離**である
2. **Stability Pool** — eUSD を預けて清算債務を吸収し、担保を割引で受け取る
3. **Recovery Mode** — system TCR が CCR(150%) を割ると清算閾値が MCR でなくなり、**その時点の TCR** を下回る Trove が対象になる。全員の線が同時に動く点が Aave の per-position HF と対照的
4. **sorted list 上の位置** — 償還は最下位 ICR から walk するので、借り手は「自分の前にどれだけ債務があるか」を守る

自作なのは 2 つだけで core は無改変：

- `LiquityPriceFeedAdapter` — Liquity は wiring 後に ownership を renounce するのでオラクルアドレスが永久固定になる。一方 run は毎回新しい PriceFeed をデプロイするので、その間に挟んで毎 run 差し替える
- `LiquityRedemptionHelper` — **部分償還のヒントは実行時価格に依存する**。環境はブロック毎にオラクルを書き、しかもエージェントより先に入るので、オフチェーンで計算したヒントは構造的に必ず陳腐化する。helper は `fetchPrice()` で価格を確定させた同一 tx 内でヒントを計算する

清算側には同種の仕組みは要らない。`liquidate()` には実行時に一致しなければならない値が無く、価格が戻れば単に revert してガスを捨てるだけだからである。

担保は native ETH（core が `msg.value` で受ける）。アクション側は WETH wei 建てで `buildTxs` が `WETH.withdraw` を前置するが、**ガスと同じ残高**なので全部突っ込むと閉じる tx すら送れなくなる。観測に `ethBalanceWei` / `suggestedGasReserveWei` を出すが**強制はしない**（self-stranding は正当な負け）。

## 3.4 トークンと値付けの種別

`TokenKind` は 3 値（`sdk/src/types.ts:13`）。**種別が値付けの経路を決める**。

| kind | 例 | 値付け |
|---|---|---|
| `base` | WETH / WBTC | fair price feed。scorer の spot 掃引が値付ける |
| `stable` | USDC / DAI / eUSD | USDC は numéraire で $1 固定。市場を持つものは両側 probe の幾何平均 |
| `lst` | LST | **venue 自身が値付ける**。spot 掃引から外す |

`lst` を独立の種別にしているのは二重計上を避けるため。base にすると scorer の spot 掃引が fair price で額面評価する一方、アダプタが別途「実現できる額」でマークするので、同じ資産が 2 回数えられて**間違った数字**になる。

### 3.4.1 市場価格 stable

「stable = $1」という断定を外した機構（issue #27、`sdk/src/stables.ts`）。

- 価格は**両側の executable probe の幾何平均** `sqrt(sell × buy)`。片側だけだと売り側に張り付いて過小評価する
- **採点はその価格 × 枚数ではない**。probe は $1,000 の取引なので、大きな保有を mid で数えると売れない値段になる。採点は agent ごとに財布と全 venue の枚数を合算し、自分サイズの売却 quote（債務は買い戻し quote）の 5 ブロック中央値で評価する（`core/src/realtime/reconstruct.ts` の `ownSizeStableAdjustments`。仕様は 06-scoring の G7）。mid は観測・face mark・quote が返らないときの fallback（`mid-fallback` として報告）
- quote が返らなければ **par に落として `par-fallback` として報告**する。黙って par が最悪で、黙って 0 は「100% ディスカウント = 無限の裁定」に読めてもっと悪い
- **USDC は numéraire で $1 固定**。全 metric が USDC 建てなので、ここを浮かせると過去 run の数字の意味が変わる
- `obs.balances.stables[<symbol>].marketQuoted: false` は「市場が答えなかったので par を仮置きした」であり、**`priceUsdc: 1` を「ペグが保たれている」と読んではいけない**
- どの stable がどのプールで値付くかは `STABLE_MARKET_LEGS`（`sdk/src/constants.ts`）が単一の出典。leg は `venue` を持ち、**その protocol が有効な run にだけ**その stable が入る
- **市場を持つ stable は funding で配らない。** これから割れる stable を全員に配ると、損が「誰も選んでいないポジションの β」になる。買って初めて持てるのがこの regime の要

現在の市場価格 stable は eUSD（`liquity`）と DAI（`curve`）。eUSD には**償還フロア**があるのでディスカウントは行使できる請求権だが、DAI には無いので「戻ると信じるかどうか」になる = 別のスキル。

## 3.5 無裁定の維持

較正済みのプール群は、**実行可能な** venue 間往復で利益を出してはならない。出るなら較正が壊れている（ADR 0007 が要求する α 支配が崩れる）。

| 時点 | 検査 | 閾値超過時 |
|---|---|---|
| 起動時 | `noArbFindings` を全 venue ペアで評価 | `STARTUP_FAIL_BPS` 超で **throw**、`STARTUP_WARN_BPS` 超は警告 |
| 毎ブロック | `NoArbMonitor` が持続性を見る | 連続して続けば `no_arb_persistent_warning` |

**一過性の裁定機会はエージェントが取るべき α で、持続する裁定機会は構造的な価格の壊れ**である。両者を分けるのが監視の目的（`core/src/realtime/noArb.ts`）。

過去に実際に壊れた例：WBTC で全エージェントが失血した事象の根本原因は「curve 観測の fair 張り付き」と「片側 probe のバイアス」の 2 層で、twocrypto の動的手数料が実際の bid-ask を ~128bps に広げていたのに 30bps 固定で補正していたため**幻のスプレッド**が見えていた。両側 probe（`TwoSidedQuoteFields`）と実効コストの観測はこの修正から来ている（`sdk/src/types.ts:393-398`）。
