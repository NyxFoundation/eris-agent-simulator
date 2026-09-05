# 脅威モデル: エージェントが任意コントラクトをデプロイできる環境

issue #40 T0。**この文書は capability の definition of done の一部**であり、任意バイトコードを
開くリリースと同じ release に入る。ADR 0022 が「何を作ったか」、これは「それによって何が
攻撃面になり、どこで止めているか」。

## 前提が変わった点

これまで、環境のチェーンにトランザクションを送る主体は**環境が鍵を持つウォレットだけ**だった
（admin / keeper / flow bot / setup / 各エージェント — 最後のものも運営が spawn したプロセス）。
したがって「この setter は誰でも呼べる」は**結果を持たない事実**だった。

任意バイトコードと任意 tx を開くと、そこが変わる。以下はすべて「前から穴だったが、
到達経路がなかったので害がなかった」ものである。

## 1. 環境コントラクトの特権書き込み

### 実測方法

主張ではなく**計測**する。役割を持たないアドレス（`0x…feedbeef`）から各特権書き込みを
`eth_call` で模擬し、**revert しなかったら穴**、revert したらガードが効いている。
実装は `core/src/realtime/ownerGuards.ts`、run 起動時（全 venue 配線後・エージェント起動前）に
実行され、結果は `owner_guard_audit` として events.jsonl に残る。

ソースを読む方式にしなかった理由: **vendor のコントラクトはソースが本 repo に無い**
（Aave の TestnetPriceAggregator、GMX、Curve、Balancer、Liquity core）。実測なら同じ 1 本で覆える。

`agentMarkets.enabled: true` の run では、未保護の特権書き込みが 1 つでも残っていれば
**起動時に fail-fast**。false の run では報告のみで続行する（同じ穴に到達経路がないため、
既存レジームは 1 つも壊れない）。

### 見つかったもの（本 issue で塞いだ）

| コントラクト | 書き込み | 状態 | 影響 |
|---|---|---|---|
| `contracts/MockAggregator.sol` | `setAnswer` | **穴だった → owner ガード追加** | Aave のオラクルソース。全借り手の清算を任意に決められた。しかも blocks.csv 上は環境自身のオラクル更新と見分けがつかない |
| `contracts/MockOracleProvider.sol` | `setPrice`（2 overload） | **穴だった → owner ガード追加** | GMX の建玉はここでマークされる。全 perp の清算と PnL を任意に決められた |

どちらも `owner` を `immutable` にしてある。ストレージを消費しないので**スロット 0 は
`_answer` のまま**で、ADR 0011 の economic-gas 経路（スロット直書き）はバイト単位で不変。

### もともと塞がっていたもの（実測で確認）

| コントラクト | 書き込み | ガード |
|---|---|---|
| `contracts/PriceFeed.sol` | `setPrice` / `setPriceFor` | `require(msg.sender == owner)`、owner は immutable |
| `contracts/MarketRegistry.sol` | `register` | 同上（registrar のみ） |
| `contracts/VulnPoolFactory.sol` | `createSimplePool` / `createRiggedPool` | `require(msg.sender == owner)` |
| `deployer/contracts/MockLSTVault.sol` | `setRewardRate` / `slash` / `setOperator` / `setWithdrawalDelayBlocks` / `setQueueThroughput` | `onlyOperator` |
| Aave `PoolConfigurator` | reserve 開設 | `POOL_ADMIN`（＝この環境では deployer）。**これが Aave をエージェントへ開けない理由**であり、`SimpleLending` が存在する理由 |

`contracts/MockERC20.sol` の `mint` は誰でも呼べるが、**本番経路にはデプロイされない**
（fork は実トークン、ローカルデプロイは deployer 自身の mock を使う）。テスト fixture 専用。
それを本番へ持ち込むと "cheatcode-free" の穴になるので、ADR 0021 §7 の起動チェックが
`assertTokensNotMintable` で scored token の mintability を実測して落とす。

## 2. 鍵の露出（未解決・運用側の課題）

**コントラクトのガードがどれだけ正しくても、特権鍵が既知なら意味がない。**

| 鍵 | 何を持つか | 現状 |
|---|---|---|
| deployer（anvil account 0） | 全 venue の seed した LP、genesis Trove、vuln プールの原資 | **既定 mnemonic 由来。公開環境では既知** |
| treasury EOA | external chain の資金供給元 | `TREASURY_PRIVATE_KEY`。運用で分離する前提 |
| admin / keeper / setup | オラクル書き込み、GMX keeper、registry 登録 | 既定 anvil アカウント |

これは**コントラクトの所見ではなく運用の所見**なので、本 issue では塞がず記録する。
塞ぎ方は 2 つあり、どちらもこの repo の外側にある:

1. 公開環境の genesis を既定 mnemonic 以外で焼く（＝ #35 / インフラ側）
2. RPC ゲートウェイの手前で参加者と運営のネットワーク境界を分ける（`infra/cloudflared`）

**この項目が閉じるまでは、任意バイトコードを開いた公開環境を「攻撃耐性がある」と
言ってはならない。**ガードの実測が通ることと、鍵が漏れていないことは別の主張である。

## 3. ブロック容量（ガス予算）

規約 §5 が上限を定めているのは 1 ブロックあたりの**本数**であって**ガス量**ではない。
エージェントが自分のコントラクトをデプロイできると、高価に書かれたコードへの 1 回の呼び出しが
ブロックガスリミット（320,000,000）を食い、他の参加者と**環境自身のオラクル更新**を飢えさせられる。
オラクル更新が落ちたブロックは全員の観測が古くなるので、これは対戦相手への攻撃ではなく
**競技基盤への攻撃**である。よって規約 §6 / §8 の失格対象。

3 か所が**同じ 1 つの数字**を読む。3 つ別々に持つと必ずズレ、ズレたときに効くのは
失格させる側なので、環境が run ごとに配る:

| 層 | 何を見るか | 挙動 |
|---|---|---|
| RPC ゲートウェイ | 署名済み tx の gas limit（RLP デコード。実行しない） | 超過を **403** で入口拒否。`RPC_MAX_TX_GAS` |
| エージェントランタイム | `estimateGas` の結果と 1 ブロック内の累計 | 送らずに `rejected` を mempool ログへ。`ERIS_MAX_TX_GAS` / `ERIS_MAX_AGENT_BLOCK_GAS` |
| run 後検査 | blocks.csv の `gasUsed`（receipt 由来） | per-tx と per-agent-per-block を `gas_budget_violations` に記録 |

既定値: **per-tx 30,000,000 / per-agent-per-block 90,000,000**（= 本数上限 3 × per-tx）。
ブロックガスリミットの 90/320 なので、1 体が枠を使い切っても環境の書き込みと他者の余地は残る。

**ゲートウェイは境界ではなく最初の壁**である。自己ホスト参加者はノードへ直接送れるので、
権威は**チェーンに着地したもの**＝ run 後検査。ゲートウェイが先に落とすのは、
検査が見える頃には飢えたブロックがもう過ぎているからにすぎない。

## 4. エージェント同士の攻撃面（＝競技の一部。塞がない）

規約 §8 が明示的に認めている側。ここに列挙するのは「塞ぐため」ではなく
**環境側の穴と取り違えないため**である。

| クラス | どう成立するか | 何が守りか |
|---|---|---|
| honeypot トークン | 売れないトークンをプールに上場する | ラウンドトリップ規則。抜けられなければ 0 |
| owner drain | 自分が owner のコントラクトに預けさせて引き抜く | 同上 ＋ registry の `verified` が false であること |
| 偽オラクル | 自分が握るオラクルで貸出市場を作る | `oracleOwner` の観測。`0x0` 以外は「誰かが動かせる」 |
| proxy 差し替え | 観測と執行の間に implementation を替える | 登録時 codehash と現在 codehash の比較（エージェントの仕事） |
| 無制限 approve の悪用 | 被害者が `MaxUint256` を承認している | ランタイムは毎回**必要額ちょうど**しか承認しない。観測に未消化 allowance が出る |

いずれも**環境は ground truth を持たない**。スコアがそのまま帰結であり、
罠の成功は移転として記録される（捏造された価値にはならない ＝ ADR 0022 公理 2 と 3）。

## 5. 塞いでいない・今後の課題

- **鍵の露出（§2）** — この repo の外。**公開前の赤いブロッカー**として扱う
- **内部 CREATE の取りこぼし** — コントラクト内部からデプロイされたコントラクトは registry に
  出ない。対称なので受け入れる（誰にも見えないものは誰も釣れない）
- **vendor コントラクトの特権書き込みの網羅性** — 実測プローブは**列挙したものしか見ない**。
  Curve / Balancer / GMX / Liquity の admin 関数は、それぞれ deploy 後に ownership を
  deployer が握るか renounce しているかで決まる。プローブ集合を増やすのは 1 行ずつであり、
  **増やしていないものは「安全」ではなく「測っていない」**
- **リエントランシ** — `SimpleLending` は mutex を持つが、任意トークン・任意オラクル・
  任意 IRM を呼ぶ以上、被害はその市場の参加者に閉じる設計に依存している。
  シングルトンの他市場へ波及しないことは、状態がすべて `id` で分離されていることに拠る
