[← 目次](README.md) ｜ [← 03 市場環境](03-market.md) ｜ [05 エージェント契約 →](05-agent-contract.md)

# 04. ストレスイベント

出典 `core/src/realtime/events.ts`（スケジュール）、`core/src/realtime/{liquidity,stableDepeg,whale,lst}.ts`（実行）。config の `stress:` セクションで指定する。既定は無効。

## 4.1 共通モデル

| 原則 | 内容 |
|---|---|
| **値ではなくレンジを与える** | `magnitudeRange` / `windowFrac` は `[min, max]`。実際の値は seed から決定論的に引く。定数の暗記を防ぎ、汎化を測る（ADR 0004） |
| **独立した Rng** | salt `0x53545253`（"STRS"）を seed に XOR する。価格の主系列と flow の Rng を乱さない |
| **純関数** | `EventSchedule` は `(config, seed, runBlocks)` からスケジュールを決める。チェーンにも I/O にも触らない |
| **固定長 run が必須** | 窓の位置は run 長の割合なので `run.blocks > 0` でなければ throw |
| **窓は run 窓に収まる** | `startBlock` は `runBlocks − span` にクランプされる |
| **RNG 消費は設定リストの純関数** | `side` / `kappaMult` は使わない型でも**必ず引く**。条件付きにすると、あるイベントの設定が後続イベントのスケジュールをずらす |

## 4.2 型と「どう消費されるか」

9 種。実装は `EVENT_KIND`（`events.ts:81`）が**全型に対する total な Record** で、新しい型を足して消費側の対応を忘れるとコンパイルが通らない。

| type | 消費 | 何をするか |
|---|---|---|
| `spike` | overlay | fair price を窓の間だけ上へ歪める |
| `crash` | overlay | 同じく下へ |
| `lstSlash` | point | LST vault の償還レートを 1 ブロックで恒久的に下げる |
| `whale` | point | 単発の大口成行注文。**fair price は動かない**（プールだけが動く） |
| `liquidityPull` | state | プールの depth を窓の間だけ引き抜き、閉じたら戻す |
| `eusdDepeg` | state | eUSD を自分の市場へ売り、閉じたら買い戻す |
| `depeg` | state | 同じ機構を任意の市場価格 stable に（`stable:` 必須） |
| `cexDrift` | process | **価格の walk 自体**を変える（drift 加算・kappa 弱化） |
| `flowTrend` | process | uninformed フローを窓の間だけ傾ける |

**消費の 4 分類**（`events.ts:67-75`）：

- **overlay** — 毎ブロック fair price に掛かる乗数（`at()`）
- **point** — 落ちたブロックで 1 回実行（`pointEventsAt(fromIndex, toIndex)`）
- **state** — 窓の間、coordinator が venue を**毎ブロック目標へ reconcile** する（`depthMultiplierAt()` / `depegFractionAt()`）
- **process** — 生成器自身が窓の間だけ読むパラメータ（`ouOverrideAt()` / `flowTrendAt()`）

**なぜ state が「一撃 removal」ではないか**：目標は blockIndex の純関数なので、ブロック通知がドロップしても 1 ブロックの遅れで済む。一撃だとドロップした瞬間にプールが間違った depth に取り残される。`pointEventsAt` が**範囲**を取るのも同じ理由で、単一 index にマッチさせていた頃はドロップ 1 回でストレス軸が丸ごと消えていた。

## 4.3 台形

```
envelope(t) ∈ [0,1]、t = blockIndex − startBlock

t < 0                    → 0
t < ramp                 → (t+1)/ramp          立ち上がり（窓の最初のブロックから効く）
t < ramp+hold            → 1                   保持
persist:true             → 1                   閉じない（以降ずっと 1）
t < ramp+hold+decay      → 1 − (t−(ramp+hold)+1)/decay   減衰
それ以降                  → 0
```

`spike` は `wethMult = 1 + m·e`、`crash` は `1 − m·e`。瞬間的なジャンプはオラクル更新の 1 ブロック遅延と相性が悪いので、**全員が等しく 1 ブロック遅れで反応できる余地**を残すために台形にしている（ADR 0009 §1）。

point イベントの窓は 1 ブロック（`POINT_EVENT_SPAN`）。

## 4.4 型ごとの仕様

### `spike` / `crash`

`magnitude` = 価格乗数の偏差幅。`base:` で対象を選べる（既定 WETH）。

### `lstSlash`

`magnitude` = ステーキングプールの焼却割合（0.02 = 2% slash）。**1.0 未満に制限**（排他）— 100% だと `totalPooledWeth` が 0 になり `convertToAssets` が 1:1 分岐に落ちてプールの rate oracle が par に戻り、**全ステーカーが黙って消える一方でディスカウントは 0 と読める**。

**discount は開かない**（プールが rate oracle 追随でリプライスする＝オラクルが正しく効いている証拠）。slash は「保有者が損をする」リスクであって裁定機会ではない。よって magnitude は**利回りスケールで較正する** — 70 ブロック run の利回り約 3〜8bps に対して 10〜30bps。最初に試した 100〜300bps は利回りの 15 倍で、ステーク自体が常に負けになった。

### `whale`

`magnitude` = **base の絶対枚数**（30 = 30 WETH の成行）。割合でないのは、効くかどうかがプール depth との相対で決まり、depth は config ではなく deploy の性質だから。

- `venue:` 既定 `uniswap`（最も深いプール = サイズが本物でないと動かない）
- `side:` 既定 `random`（seed が決める。公開 regime の seed 群で方向が暗記されるのを防ぐ）
- **crash との違い**：crash は fair 自体が動く。whale は fair が動かないままプールが叩かれる = **乖離の向きが逆**で、見つけるべき取引が違う
- 通常の flow 経路で中継されるので、署名・順序・帰属は他の flow 注文と同じ。専用ウォレットから出るので、block 0 の残高を見れば**予期可能**（意図的）

### `liquidityPull`

`magnitude` = 台形の頂点で引き抜く depth の割合。**1.0 未満に制限**（板が消えると全 swap が revert し、「薄い板」ではなく「停止」になる）。

- `venue:` **省略時は有効な全 venue**。1 つだけ薄くしても執行が他所へ移るだけなので、narrowing が opt-in
- **両側比例**で抜くので mid は動かず、無リスク裁定は開かない
- 環境が seed した LP（deployer = anvil account 0）を動かすので、ロスターが同じ口座を使っていると fail-fast（[02 §2.1](02-runtime.md)）
- fork では seed した LP が存在しないので同じく fail-fast
- ローカルデプロイ専用

### `eusdDepeg` / `depeg`

`magnitude` = プールの seeded stable depth のうち環境が売った割合（0.3 = 100k プールに 30k 売却）。**1.0 未満に制限**（売り切ると買うものが無くなり、ディスカウントが価格ではなく停止になる）。生じるディスカウントは**カーブの性質**であってこの数値ではない。

- `depeg` は `stable:` が**必須**。run が複数の stable を持ちうるので、黙って 1 つ選ぶとレジストリ順に依存する regime になる
- 実装は共通（`core/src/realtime/stableDepeg.ts`）。イベント名だけが `stress_eusd_depeg*` と `stress_depeg*` に分かれる
- 開く取引が違う：**eUSD には CDP が強制する償還フロアがある**が、素の stable には「ドルであるという信念」しかない。前者は担保への請求権、後者は意見

### `cexDrift`

**価格の walk 自体**を変える（`ouOverrideAt`）。

```
driftAdd += (side === "sell" ? −1 : +1) × magnitude × envelope(t)
kappaMult *= 1 + (ev.kappaMult − 1) × envelope(t)
```

- `kappaMultRange` で平均回帰を弱める。**drift だけ足しても OU がすぐ引き戻すのでドリフトにならない**（`cex-drift` regime は run 全体 kappa 0.004 対既定 0.02 = 倍率 0.2 でこれをやっていた）
- overlay ではないので、**窓が閉じても価格は戻らない**（それがドリフトの意味）
- `repriceAnchor: true` なら anchor 自体を「これまでに適用した drift ぶん」動かす（`anchorMultiplierAt`）。平均回帰がエピソード中に抗う相手がいなくなり、到達した水準が常態になる

### `flowTrend`

uninformed フローを窓の間だけ傾ける（`flowTrendAt`）。

- `magnitude` = サイズ倍率（`informed-flow` regime は 3x）
- `trendCorrelation` / `persistBlocks` は**台形でフェードしない**。窓が開いている間フル適用される — 「ramp 中は相関 0.5」は弱いレジームではなく**別のレジーム**だから

## 4.5 合成規則

| 対象 | 合成 |
|---|---|
| 価格 overlay | **乗算**（`baseMults[base] *= 1 + sign·m·e`） |
| depth | **乗算**（`byBase[base] *= 1 − m·e`） |
| depeg の売却割合 | **加算**（重なった 2 つの投げ売りは 2 つ分の eUSD を売る） |
| OU の drift | **加算**、kappaMult は**乗算** |
| flowTrend の sizeMult | **乗算**、shape ノブ（correlation / persistBlocks）は **max** |

## 4.6 `alignWith`

窓の開始位置を他の型のイベントと共有する。

**「同じレンジ」は「同じ窓」ではない。** 同じ `windowFrac: [0.25, 0.7]` でも 360 ブロック run では平均 ~160 ブロック離れて落ちる。「gap の最中に板が薄い」は**組み合わせの性質**なので、明示しなければ成立しない（issue #52。使用例 `config/regimes/crash.yaml`）。

制約：

- 自分と同じ型は指定できない（2 つあると曖昧で、何も言っていない）
- **連鎖は禁止**（アンカー自身が aligned なら throw）。解決順に依存して半分の確率で正しくなる挙動を許さない
- アンカーが run 終盤にあり、追随側の台形の方が長い場合は throw。黙って前へずらすと**alignWith が保証する唯一のことが崩れる**
- `windowFrac` は指定必須で、draw も行われる（使わないだけ）。RNG 消費を設定リストの純関数に保つため

## 4.7 「戻さない」2 つのフラグ

既定では窓が閉じると環境が買い戻し、OU も初期 anchor へ引き戻すので、**どの価格変動も一時的**になる。すると「par に戻るか」の答えが常に yes になり、粘る戦略が判断ではなく構造で勝ってしまう（issue #56）。

| フラグ | 対象 | 効果 | 制約 |
|---|---|---|---|
| `persist: true` | `depeg` / `eusdDepeg` | 水準を run の最後まで保持 | **`decayBlocks: 0` 必須**（decay を黙って無視すると「閉じる窓」に読めるため throw） |
| `repriceAnchor: true` | `cexDrift` | OU の anchor をドリフト分だけ動かす | — |

**teardown の買い戻しは残る。** 起動チェックがデペグ済みプールを拒否するので、放置すると次の run が始められなくなる。買い戻しは**最終採点ブロックより後**に行われる（[02 §2.1 G](02-runtime.md)）。

## 4.8 清算 victim

`stress.victimCount`（既定 0 = 無効）/ `stress.victimHf0`（既定 1.10）/ `stress.victimWethWei`。seed 由来のアドレス群に Aave ポジションを建てる。**採点対象外**なので liquidator エージェントの利益源になる。

### 較正の連動

| 条件 | 式 | 例 |
|---|---|---|
| 建てられること | `HF0 ≳ LT / (0.97 × LTV)` | Arbitrum WETH の LT=0.84 / LTV=0.80 で ≈1.08。これ未満は borrow が LTV 縁に張り付くので fail-fast |
| 割れること | `crash の magnitude m > (HF0 − 1) / HF0` | HF0=1.10 なら m > 9.1% → `[0.12, 0.16]` で確実に割れる |

breach 不能な設定は `stress_calibration_warning` を emit する（throw ではない）。borrow がサイレント revert した場合は setup で debt を検証して fail-fast する。

### fresh state 要件

soft-reset だと前 run の victim ポジションが残留して HF が壊れるので、次のいずれかが必要（満たさなければ throw）。

- fork：full re-fork（`ARB_RPC_URL` 設定 + `run.skipReset` 不可）
- ローカルデプロイ：`resetFork` の snapshot/revert クリーン断面

ローカルでは victim を建てる前に Aave オラクルを初期 fair price へ較正する（fork の「オラクル ≈ 実勢 ≈ fair0」が成立しないため。coordinator が自動実行）。

**victim のアドレスは `ERIS_LIQUIDATION_VICTIMS` で liquidator エージェントに配る**（[01 §1.3](01-architecture.md)）。

## 4.9 設定の検証（fail-fast）

`parseStressEvents`（`events.ts:616`）が起動前に throw する。

| 検査 | 内容 |
|---|---|
| type | 9 種以外は拒否 |
| `stable` | `depeg` では必須、他の型では指定不可 |
| `side` | `whale` / `cexDrift` のみ。`buy` / `sell` / `random` |
| `persist` | `depeg` / `eusdDepeg` のみ、かつ `decayBlocks: 0` |
| `repriceAnchor` / `kappaMultRange` | `cexDrift` のみ |
| `trendCorrelation`（0..1）/ `persistBlocks`（整数 ≥1） | `flowTrend` のみ |
| `venue` | `whale` / `liquidityPull` のみ。3 venue のいずれか |
| `magnitudeRange` | `min > 0`。`lstSlash` / `liquidityPull` / `eusdDepeg` / `depeg` は `max < 1` |
| `windowFrac` | `[0,1]` の範囲 |
| ramp/hold/decay | 非負整数。point 以外は合計が正 |
| `alignWith` | 型名であること・自分と違う型・連鎖でないこと |

さらに coordinator 側の起動時検査（[02](02-runtime.md)）：

- `whale` が指す venue が無効 → throw
- `eusdDepeg` に `liquity` が無い → throw
- `depeg` が localDeploy でない → throw
- `depeg` の対象 stable が「この run で市場から値付かない」→ throw（値付かない stable は $1 で採点されるので、イベントが何をしても意味がない）
- `liquidityPull` / depeg 系が deployer 口座を使うのに、同じアドレスのエージェントがいる → throw

## 4.10 emit されるイベント

| イベント | 意味 |
|---|---|
| `stress_schedule` | 解決済みスケジュール全体 + `runStartBlock`（絶対ブロックで窓を判定できる） |
| `stress_calibration_warning` | crash の magnitude が victim HF を割れない可能性 |
| `stress_victims_setup` / `stress_victim_hf` | victim の初期 HF / 窓の間の HF 推移 |
| `stress_liquidation` | victim の債務減少を清算として検出 |
| `stress_whale_funded` / `stress_whale` / `stress_whale_failed` / `stress_whale_reverted` | whale の資金配布・発火・失敗・**オンチェーン revert** |
| `stress_liquidity_pull`（`_setup` / `_failed`）/ `stress_liquidity_restored`（`_incomplete`） | depth の引き抜きと復元 |
| `stress_eusd_depeg*` / `stress_depeg*`（`_setup` / `_capped` / `_failed` / `_restored`） | デペグの各段 |
| `lst_slash_failed` / `lst_apy_changed` | LST 側 |
| `stress_run_time_limit_disabled` | 時間制限の自動無効化 |

**`stress_whale_reverted` が独立している理由**：whale は通常の relay を通るので**送信エラー**は捕捉されるが、**オンチェーンの revert はエラーではない**。tx は着弾し、スケジュールは「whale が発火した」と言い、blocks.csv だけが何も起きなかったことを示す。approve 漏れで一度、この regime がすべてのログが健全なまま calm に退化した。

**`crash` / `spike` / `cexDrift` / `flowTrend` は毎ブロックの記録を残さない**（価格の walk 自体を変えるため）。よってダッシュボードは「never fired」とは書かず「price chart を見よ」と出す（[09](09-dashboard.md)）。

## 4.11 公式レジーム

`config/regimes/` に置かれ、シナリオ行列が参照する。

| regime | 内容 |
|---|---|
| `calm` | イベント無し |
| `cex-drift` | OU に drift、kappa 弱化 |
| `informed-flow` | 相関した方向性フロー |
| `whale` | 単発大口の点イベント |
| `lending-incident` | 暴落 + victim + 清算 + 同じ窓の引き抜き |
| `crash` | 価格ギャップ + 同じ窓での引き抜き（3 venue が同時に薄くなる） |
| `depeg` | レジストリの stable が $1 でなくなる |

`lst` / `liquity` は競技セット外（venue 単体の検証用）。

**単一種のイベントで埋めた週は特定の戦略にしか仕事を作らない。** 実測で、depeg だけの週では venue-arb が 5 seed 中 3 本で無取引だった（[`docs/scoring-metric-measurements.md`](../scoring-metric-measurements.md)）。`cexDrift` / `flowTrend` が窓イベント化されているのはこのためで、連続経済では「run 全体がドリフトしている週」を注入できない（週は 1 本で、その中に複数のエピソードが非公開スケジュールで入る）。
