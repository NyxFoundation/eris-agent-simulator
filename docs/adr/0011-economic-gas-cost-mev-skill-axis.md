# ADR 0011: gas 経済コスト化 — priority-fee 上限の撤廃と MEV の識別軸化（ADR 0010 を Supersede）

## Status

Accepted（2026-10-08）。**同日 ADR 0010 を Superseded にした。**

**同日、公式 12 レジームと `config/practice.yaml` を `economicGas: true` に切り替えた**（練習期間は次の
再起動から）。§5 の前提条件のうち、LST の accrue-first（§5-2）は実害が小さいので見送り、規約の改定
（§5-8）は ascon-web 側で行う。それ以外は同じ変更で実施した。参加者への告知は `docs/updates/2026-10-08.md`。

> 書き直しの経緯（2026-10-08）: Proposed のまま、0010 が見送った 2 つの理由のうち「資本で順番が買える」
> への回答が「資本正規化採点（未決）」に寄っていた。ADR 0020 で公式競技が `resetUnit: scenario`
> （毎エポック全員が同じ配布から始まる）になったので、その論点は採点方式に頼らず構造で消えている。
> 実測で、練習 devnet の参加者が tip を上限 5 gwei ちょうどに張り付けていることも分かった
> （s01 の blocks.csv の一部、block 44549〜54689 で 2 体が 60/63・31/32 本を 5 gwei で送信）。
> Context と §3 をそれに合わせて書き直し、2026-09 以降のコード（1 ETH 配布・全 run の gas マネージャ・
> `sdk/src/feeRule.ts`）に合わせて古い記述を直した。

## Context

agent は共有 mempool に tx を出し、anvil は **`--order fees`**（`maxFeePerGas` 降順。`sdk/src/feeRule.ts`
が `maxFeePerGas ≤ tip` を課して、並べ替えのキーと支払額を一致させている）でブロック内を並べる
（ADR 0006）。env は fair price を `PriceFeed` と各 venue のオラクルへ毎ブロック書き、価格を
α 支配へ寄せている（ADR 0007）。

ADR 0010 は **priority-fee 上限 `fees.maxPriorityFeeWei` = 5 gwei** を維持し、gas の経済コスト化を見送った。
理由は 2 つ:

1. **env の決定論的順序保証** — oracle を `cap + 1 gwei`、keeper を `cap + 0.5 gwei` で送り、
   有限の天井の上に置くことで txIndex 0 を取っている（`core/src/realtime/coordinator.ts` の
   `oracleFee` / `keeperFee`）。上限を外すと、資本の厚い agent が oracle 更新を outbid して front-run できる。
2. **α 分離（ADR 0007）** — gas 入札・トレジャリ管理が採点に混ざり、順位が「資本量 × 入札モデル」に
   相関する。

### なぜ 0010 を見直すか

- **上限は順序を実力ベースにしない。**競り合う機会を取りに行く合理的な戦略は**全員が上限ちょうどを積む**。
  同値の tx の並びは手数料では決まらず（anvil の同値時の順序は未実測。到着順なら着順＝レイテンシ）、
  清算に限らずアービトラージ・backrun を含む全ての競合機会で勝者が手数料以外で決まる。
  練習 devnet で実際に起きている（上の経緯）。上限は「公平な順序」ではなく
  「資本で順序を買えなくする＋env を最前列に固定する」道具にすぎない。
- **「ガス＝タダ」の前提は本番と乖離する。**実チェーンではガスは実コストで、機会を評価して入札する力は
  DeFi の execution スキルそのもの。上限がその次元を潰している。

### 0010 の 2 つの理由への回答

1. **順序保証** — 上限という天井ではなく、**価格を tx でなく state-write で確定する**ことで保証する（§1）。
   価格はブロックが開く前に storage にあるので、追い越す対象の tx が存在しない。手数料をいくら積んでも
   順序保証は崩れない。
2. **資本バイアス** — **公式競技では成立しない。**
   - 公式競技は `resetUnit: scenario`（ADR 0020 §2）で、**毎エポック全員が同じ配布**（バスケット +
     ガス用 ETH、規約 §4.2）から始まる。前のエポックで稼いだ資本は持ち越されない。
   - 1 本の tx に払える上限は「ETH 残高 ÷ gas」で、WETH を unwrap すれば配布だけで数十 ETH 相当になる。
     実際に効く上限は残高ではなく**機会の利益**で、それは全員にとって同じ額。よって競り合いで勝つのは
     「機会を高く評価した者」であり、資本量ではない。これは本 ADR が識別軸にしたいスキルそのもの。
   - エポック内では序盤に稼いだ agent の在庫が増えるが、取れるサイズの上限はプール深度で、上限の有無と
     無関係に既に存在する差である（上限撤廃が新たに作る偏りではない）。
   - 練習期間（`resetUnit: continuous`）は資本を持ち越すが、公式採点ではなく、順位も日次リターン
     （`core/src/scoring/practiceReturn.ts`）で測っている。
   - 0010 の「gas トレジャリ管理をしくじって停止するノイズ」は、全 run で動く gas マネージャ（ETH が
     足りなくなれば自分の WETH から補充する。2026-09-28 から）が既に吸収している。

### 検討した選択肢

| 観点 | A: 現状維持（上限） | B: 経済コスト化（本 ADR） | C: 清算だけ経済 fee |
|------|---------------------|---------------------------|---------------------|
| env の順序保証 | 有限プレミアム（上限依存） | **state-write で機械的に保証** | 通常は上限・例外枠に穴 |
| 競合機会の勝者 | 手数料以外（着順など） | **機会を高く評価した者** | 清算のみ実力 |
| 測るスキル | α / リスク管理 | **α + execution / MEV** | 部分的に execution |
| 現実性 | 低い | **高い** | 中 |
| 資本バイアス | 無し | **scenario リセット下で無し** | 無し |
| 再現性／分散 | 低分散 | 入札の内生分で増える | 中 |

C は例外枠の front-run と規約の複雑化が残る。**B を採る。**

## Decision

**priority-fee 上限を撤廃して gas を実コスト化し、機会評価に基づく priority-fee 入札を識別軸にする。
env の順序保証は「上限＋プレミアム」から「ブロック境界での state-write」へ移して上限から切り離す。
ADR 0010 を Supersede する。**切替は `run.economicGas`（既存）で行う。

### 1. env 順序保証を state-write へ

価格を tx でなく **`anvil_setStorageAt` で storage に直接書く**。価格配布は env の機構で agent の動作では
ないので、cheatcode を使っても agent 側の現実性は損なわれない。agent からの読み口
（`PriceFeed.latestAnswer`・各 venue のオラクル）は不変で、1 ブロック遅延の仕様も維持する。

```
上限方式:      [block N] txIdx0 = oracle(cap+1gwei)  txIdx1.. = agents(≤ cap)
state-write:   <env が storage を直接 set（tx 無し）>
               [block N] txIdx0.. = agents（fee 自由）  ← 追い越す対象が存在しない
```

venue ごとの扱い:

| 対象 | 今の economicGas | 本 ADR の扱い |
|------|------------------|---------------|
| `PriceFeed`（全 base） | storage 直書き（`writePriceFeedStorage`） | 済 |
| Aave aggregator（全 base + LST 担保） | storage 直書き（`writeAaveOraclesStorage`） | 済 |
| GMX `MockOracleProvider` の価格 | 以前は admin 鍵からの `setPrice` tx（通常 fee） | **storage 直書き**（`updateGmxOracle(…, {storage: true})`。実施済み） |
| GMX keeper（`executeOrder` / 清算） | tx（通常 fee） | **tx のまま、ただし 50 gwei 固定**（`ECONOMIC_KEEPER_FEE_WEI`）。keeper は実行時に provider を読むだけなので、ブロック内の位置で約定価格は変わらない。固定するのは**ブロックから締め出されない**ため: 0.1 gwei のままだと、参加者数体が 0.11 gwei で 30M のブロックを埋めれば（1 体 10M まで、約 0.003 ETH）約定と清算を何ブロックでも遅らせられた（2026-10-08 のレビューで指摘）。keeper は anvil で 200 万 ETH を持つ |
| LST `accrueRewards` / `setRewardRate` | admin 鍵からの tx | **tx のまま**。利用者関数の accrue-first 化（§5-2）は見送った |
| flow bot | mempool tx | 変更なし（env の市場機構で採点対象外） |
| stress の売買（liquidityPull / depeg） | deployer 鍵の tx | 変更なし（市場に対する取引であって価格の確定ではない） |

`chainMode: external` は storage を書けないので、economicGas との組み合わせは起動時に拒否する（実装済み）。

### 1b. 環境が事象を起こす tx の入札（2026-10-08 追加）

価格は storage 直書きで追い越せないが、**事象そのものを起こす tx**（launch の買い波・売り戻し、depeg の
売りと買い戻し、流動性の引き抜き）は普通の tx として手数料の競りに入る。固定の手数料では、
上限 + 1 gwei なら常に先頭（先回りは不可能）、既定の 0.1 gwei なら常に先回りできる（実測: launch#101 で
3 gwei の参加者が波の買いの全部に先回りし、+2,000 USDC 多く取った）。どちらも腕の差にならないので、
**1 tx ごとに先回りの価値に比例した乱数の額を入札する**（`core/src/realtime/envBid.ts`）:

```
priority fee / gas = U × V / 150,000,   U ~ lognormal(中央値 0.86, σ 0.6)   → P(U < 1) ≈ 0.60
```

- **V** は環境が送信前に見積もる「先回りで取られうる額」。買い波・depeg は自分の注文の価格影響コスト
  （限界レートでの受取額 − 実際の見積もり。プール手数料は比で相殺）。引き抜きは参照サイズ $10,000 の取引が
  厚い板で約定して得するスリッページの差（N²/2 × (1/D_後 − 1/D_前)、D は deploy 時の片側 $3M を今のプールの
  規模で縮めた値）。戻し（深さが戻る側）は先回りしても得しないので V = 0。
- **割る gas は先回りする側の tx の gas**（参照値 15 万 = `FRONT_RUN_REFERENCE_GAS`。Uniswap の exactInputSingle や
  Curve の exchange が 11〜25 万）。先回りする側は 1 gas あたりの額を上回ればよく、自分の gas 分だけ払う。当初は
  環境の tx の gas 上限（60〜90 万）で割っていて、実効の入札が U × V の約 2 割になり、先回りが約 99.8% で得に
  なっていた（同日のレビューで指摘、修正）。
- **V は価格影響のコストで、サンドイッチで取れる上限（環境の注文の許容スリッページ。launch の波は 15%）より小さい。**
  そのため実際の先回りの価値は V より大きくなりうるが、そのままにした（2026-10-08 判断）。
- **環境のイベント取引が mempool で待っていることは、`eth_getTransactionCount(deployer, "pending")` で外から分かる**
  （ゲートウェイは自分の nonce を取るためにこの 1 つを通している）。分かるのは「待っている」ことだけで、額も中身も
  1 ブロック後には誰でも見えるので、塞がないことにした（2026-10-08 判断）。
- **U** はシナリオの鍵付きストリーム（`env-bid:<種類>`）から引くので、再現でき、事前には読めない。
  約 6 割は V 未満（先回りが得）、約 4 割は V 以上（積みすぎると損）。参加者の腕は V の見積もりと、
  過去のブロックで環境が実際に払った手数料（チェーン上で見える）から U の分布を読むこと。
  当初は中央値 0.29（P = 0.98）で入れ、同日 0.60 に変えた。
- 送り主の ETH 残高の半分を超える額は付けない（払えない tx はノードに拒否され、事象が遅れるだけになる）。
- 入札額・V・U は該当の `stress_*` イベントに `priorityFeeWei` / `frontRunValueUsd` / `bidFraction` で残る
  （公開ビューでは窓が閉じるまで出ない）。
- GMX の keeper は対象外。約定はオラクル価格で、状態を変えられるのは keeper 自身だけ（成行注文は 300 秒
  キャンセル不可）なので、先回りしても取れるものが無い。

### 2. 上限の撤廃

- 参加者の tip に上限を課さない（`feeRule.ts` の cap = 0）。**`maxFeePerGas ≤ tip` は残す**
  （並べ替えのキーと支払額を一致させる規則で、これが無いとオークションにならない）。
- 3 か所の執行（ゲートウェイの 403 / 参照ランタイムの署名 / `postRunCheck` の事後検査）は同じ規則を読む。
  ランタイム（`example/agents/runtime/send.ts`）・事後検査・観測（`obs.limits`）・マニフェストは
  `economicGas` を見て上限を外す（実装済み）。**ゲートウェイは独立した env `RPC_MAX_PRIORITY_FEE_WEI` を
  読むので、切替時に 0 にする運用手順が要る**（§5）。
- env の tx（keeper・LST・flow）は通常の fee（`defaultPriorityFeeWei`）で送る（実装済み）。

### 3. gas は実コスト

- gas は ETH 残高を減らし、ETH は採点の価値に入るので、払った fee はそのまま P を削る。
- 配布するガス用 ETH は公表値（規約 §4.2。公式レジーム 1 ETH、ADR 0026 のライブ週案は 3 ETH）。
  上限が無くなると 1 本あたりの fee が大きくなり得るので、切替時に配布量を見直す（§5）。
- 競合機会では利益の大半が fee に流れる（priority gas auction）。採点は場全体の偏差値（ADR 0023）なので、
  場の P の水準が下がっても順位付けは壊れない。

### 4. ロールバック

`run.economicGas: false` で ADR 0010 の上限方式をそのまま再現できる。上限方式のコードは削除しない。

### 5. 切替の前提条件

1. **GMX の価格を storage 直書きにする — 実施。**`MockOracleProvider`（`contracts/`、run ごとに deploy）は
   `owner` が immutable でスロットを使わず、`mapping(address => Price) prices` が slot 0
   （`forge inspect` で確認）。トークンごとに `keccak256(abi.encode(token, 0))` + 0/1/2 に
   `min` / `max` / `set` を書く（`gmxOraclePriceSlots`）。deploy した mock に書いて `getOraclePrice` で
   読み返すテストが `test/gmxOracleStorage.test.ts`。state dump の焼き直しは不要。
2. **LST vault を accrue-first にする — 見送り。**`deposit` / `requestWithdraw` / `redeem` / `withdraw` が
   先に `accrueRewards()` を呼ばないので、env の計上 tx より前に入った参加者は計上前のレートで入金し、
   そのブロックの利回りを受け取れる。ADR 0028 以降の利回りは 1 エポック ~0.007bps で、1 ブロック分は
   ガス代に遠く及ばないので実害は無い。直すならコントラクト変更 + `npm run gen:state-dump` の焼き直し。
3. **書き込みの途中でブロックが切られない — 実施。**economicGas では interval mining を止め、coordinator が
   自分で掘る（`core/src/realtime/gatedMiner.ts`）。block pass は価格の書き込みを**段取りするだけ**で、
   miner が tick で「head ブロックの価格が段取りされたか」を待ち、書き込みを適用してから
   `anvil_mine` する。どのブロックも全オラクルが同じステップの価格で掘られる。pass が
   `max(3 s, 3 ブロック)` 段取りしなければ前の価格のまま掘り（チェーンは止めない）、`mining_gate_timeout`
   を記録する。手動採掘でも `--order fees` の並びは同じ（anvil 1.5.1 で実測: 5 gwei → 1 gwei の順）。
4. **価格が見えるタイミング — 3 と同じ機構で解決。**書き込みは採掘の直前に適用されるので、`latest` に
   次ブロックの価格が先に出ている時間は RPC 1 往復分だけ。観測への到達は従来どおり 1 ブロック遅れ。

   **ブロックの履歴に書き込みが残る（実装中に判明）。**anvil の `anvil_setStorageAt` は head ブロックの状態を
   書き換え、その状態がそのまま履歴になる（anvil 1.5.1 で実測: ブロック 1 の後に書いた値が、ブロック 2 を
   掘った後もブロック 1 の値として読める）。つまり **ブロック B の履歴は B+1 用の価格を持つ**。この性質は
   economicGas に元からあり、head のうちに B を読むライブ採点と、履歴から読む事後 sweep・中央値の窓が
   別の状態を読んでいた（calm#101 で `interval_series_agreement` が 0.24% のずれ。tx 方式の run は 0）。
   対処: block pass は B を読み終えてから書き込みを段取りし、ライブ採点は境界を 1 ブロック遅れて履歴から
   読む（`LiveScorer` の `readLagBlocks: 1`。終了ブロックは miner の停止時に保留中の書き込みを適用してから
   `close()` が読む）。セグメントの切れ目も 1 ブロック手前にする。修正後の calm#101 はずれ 0。
   **帰結: economicGas では「ブロック B の価値」は B+1 の取引が約定する価格で評価される**（tx 方式では B の
   取引が約定した価格）。評価の時点が価格の 1 ステップ分ずれるだけで、ライブと事後は同じ規則で読む。
   **ゲート付き採掘の運用上の性質（レビューで指摘、同日対処）。**
   - **ブロック生成が coordinator に依存する。**interval mining なら anvil が勝手に掘り続けたが、今は
     miner のループが止まればチェーンも止まる。`anvil_mine` の失敗は記録して次の枠でやり直し
     （`mining_failed`）、1 回の採掘は 10 ブロック分で打ち切る。ループ自体の例外も捕まえる。
   - **間隔は開始時刻からの固定の格子**（`blockTimeSec` ごと）。pass が遅れたら、間隔を最短で半ブロック
     まで詰めて格子に戻る（`run.endsAt` → ブロック数、評価区間の長さ、`dayBlocksRemaining` はどれも
     `blockTimeSec` で換算しているので、遅れを溜めると練習期間が `endsAt` を過ぎる = issue #129 の逆戻り）。
     30 ブロック以上遅れたら取り戻さずに格子を張り直す（`mining_schedule_resynced`）。pass は miner から
     直接起動し、ブロック検知の待ち（1/4 ブロック）を挟まない。
   - **pass が `blockTimeSec` より長いと、そのブロックだけ遅れる。**その遅れはレジーム固有の処理
     （victim の監視、launch の見積もり、depeg・引き抜きの reconcile）の重さを映しうるので、
     ブロック間隔からレジームを推測する手掛かりになりうる（未実測。3 体の calm#101 で pass は最大 60 ms、
     間隔は中央値 2.01 秒）。30 体以上の構成で pass 時間を測ること。
   - 書き込みの一部が失敗したら 1 回だけやり直す（storage への set なので冪等）。終了ブロックを処理したら
     採掘をすぐ止める（`halt`）。
   - **miner は tick ごとにチェーンの head を読み直す。**採掘がタイムアウト後に遅れて成功した、採掘後の head の読み取りが
     失敗した、再開時の setup がブロックを掘った、のどれでも miner の知る head がチェーンより遅れ、待ちを 1 回飛ばして
     古い価格でブロックを掘っていた。**最初のブロックも最初の pass の段取りを待つ**（setup の価格は段取りではない）。
   - 最終評価 V_K は、終了ブロックの履歴（= 鐘の後の 1 ステップ分の価格）で評価される。全員同じなので順位には効かない。

5. **coinbase — 確認 + 起動時検査。**anvil の coinbase はゼロアドレス（anvil 1.5.1 で実測。fee はそこへ
   入り、誰も引き出せない）。coordinator は起動時に coinbase を読み、agent のアドレスなら起動を拒否し、
   `economic_gas_enabled` に記録する。
6. **ゲートウェイ — 実施。**`infra/monitoring/docker-compose.yml` の `rpc-gateway-live` に
   `RPC_MAX_PRIORITY_FEE_WEI=0`。`maxFeePerGas ≤ tip` の拒否は残る。練習 box ではコンテナの作り直しが要る。
7. **ガス用 ETH の配布量 — 据え置き。**入札の上限は機会の利益で、参照 agent は利益の一定割合しか積まない。
   足りなくなっても全 run の gas マネージャが自分の WETH から補充する。起動時の下限検査（0.5 ETH）も
   1 ETH の配布で通る。上限なしの入札で実際にどれだけ使われるかは、切替後の run で観察する。
8. **規約 §2.6（順序と上限）の改定 — ascon-web 側。**参加者向けの告知は `docs/updates/2026-10-08.md`、
   ガイドは `docs/competition-start.md` と `docs/guide/practice-devnet.md` を更新した。

## Consequences

### Positive

- 機会評価→入札、ガスのトレジャリ管理という execution スキルが測れ、本番との戦略の乖離が縮む。
- env の順序保証が「価格がブロック開始前に storage にある」という機械的な事実で担保され、fee の天井に
  依存しなくなる。
- 着順で決まっていた競合機会が「機会を高く評価した者」で決まる。

### Negative

- ADR 0007 の「純 α 分離」が fee の次元で崩れる。ただし scenario リセット下では混ざるのは資本量ではなく
  機会評価のスキルで、α は依然として価格過程が支配する。
- 入札の内生分で結果の分散が増える（ADR 0005）。同一条件の反復で吸収する。
- 参照 agent・参加者ガイド・マニフェストの記述が上限前提で書かれているので、切替時に全部直す。

### Risks

- ガス用 ETH の過小較正で多数の agent がガス切れする → §5-7 の較正と、全 run の gas マネージャ。
- 価格の storage 直書きは実チェーンに無い特権操作 → 価格配布は env の機構で、agent からは同じ
  コントラクトの read に見えるので、参加者の体験と提出物の互換は変わらない。

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|------|------------|------------|
| ガス用 ETH の具体値 | 上限なしの入札での消費を実測してから | §5-7 の較正時 |
| 入札の soft cap | まず無制限で観測する | 1 体の入札が場を支配すると確認されたとき |

## Notes

- **ADR 0010** は本 ADR で Superseded。上限方式は `economicGas: false` として残る。
- **ADR 0009**（清算）§6 の「着順＝運」の緩和は、切替後は清算の取得順も入札で決まるので不要になる。
- 実装の場所: `sdk/src/feeRule.ts`（規則）/ `sdk/src/protocols/oracles.ts`（`writePriceFeedStorage` /
  `writeAaveOraclesStorage`）/ `core/src/realtime/coordinator.ts`（`economicGas` 分岐・`oracleFee` /
  `keeperFee`）/ `example/agents/runtime/send.ts`（署名時の cap）/ `core/src/postRunCheck.ts`（事後検査）/
  `core/src/manifest.ts`（参加者への表示）/ `infra/rpc-gateway/gateway.mjs`（入口の 403）/
  `test/economicGas.test.ts`
- 参考: ADR 0005 / 0006 / 0007 / 0009 / 0010 / 0020（scenario リセット）/ 0023（偏差値採点）/ 0026（ライブ週）
