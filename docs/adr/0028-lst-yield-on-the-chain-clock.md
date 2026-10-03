# ADR 0028: LST の利回りをチェーンの時計で積む

## Status

Accepted（2026-10-03）。同じ PR で実装した。config の既定値の変更だけで、state dump の焼き直しは要らない
（coordinator が setup で config から `setRewardRate` を送る。`core/src/realtime/lst.ts`）。

## Context

LST venue（issue #38）は利回りをブロックごとに積み、1 ブロックを `lst.simulatedSecondsPerBlock` 秒分のステークと
数える。既定は 3600（1 ブロック = 1 時間）で、これは issue #38 で venue を作ったときの値のまま、公式レジームの
較正として選び直されたことは無い。公式 12 本はどれも `lst` セクションを持たないので、この既定で走っていた。

一方、同じ世界の他の時間依存の量は全部 EVM 時間（`run.blockTimeSec` = 2 秒/ブロック）で進む。Aave の借入・供給金利、
GMX の funding と borrowing、SimpleLending の金利。ADR 0017「決めていないこと」はグローバルな経済クロックを先送りし、
ADR 0019 は「run 全体の時計は導入しない」、ADR 0022 は SimpleLending に LST の時計を使う案を「同じ世界の 2 つの貸出
venue に別々の時計を置くことになる」として却下した。**LST だけが 1,800 倍速い時計を持つ状態が残っていた**。

その帰結を数えると:

- 1 エポック 360 ブロック = 360 時間 = 15 日分。3%/yr で **12.3bps**。配布の 8 WETH をステークすると ~$30/エポック
- 公式レジームでは APY 変動・キューのスループット上限・`lstSlash` がどれも無く、出金待ちは deploy 既定の 24 ブロックで
  エポックの内側に収まる。採点（realizable）は par
- Aave は LST を LTV 70% の担保に取り、オラクルは「WETH × 償還レート」。WETH を借りて LST を積むループは ETH の
  値動きで HF が動かず、借入金利は EVM 時間で 12 分ぶん（~0）。理論上 ~3.3 倍で **~13bps of V_0 / エポック**
- つまり **「block 0 で全額ステーク、Aave でループ」が全レジームで無リスクの恒久最適**だった。T は場の中での偏差なので
  これは全員が払う税（やらない agent が負ける）になり、戦略の判断を測らない

練習期間（`config/practice.yaml`）は issue #129 で 30 秒/ブロックにしていたが、その根拠は「1 採点日 = 公式 1 エポックと
同じ 15 日分の利回り」で、公式の 1 時間/ブロックを基準として前提にしていた。15 倍速で同じ構造（~0.12%/日）を持つ。

## Decision

**`lst.simulatedSecondsPerBlock` の既定を `run.blockTimeSec` にする。**公式 12 本と練習期間はこの既定で走る
（`config/practice.yaml` の `lst.simulatedSecondsPerBlock: 30` は削除）。

- **Aave を速める（= EVM 時間を warp する）案は採らない**。ADR 0017 が先送りした理由（全 venue の再較正、
  `block.timestamp` の overflow リスク）がそのまま残る
- **`apyBps` を下げる案は採らない**。1 ブロックの利率は `apyBps × 秒/ブロック ÷ 年` なので数学的には同じだが、
  観測の `apyBps` が「3%」でなく「0.0017%」のような値になり、表示が実態を表さなくなる
- **LST の利回りを競技のスキルにする案（時計は速いまま、`config/regimes/lst.yaml` の摩擦を公式に入れる）は採らない**。
  公式 12 本の再較正が要り、ループの利鞘を消すには slash を利回りと同じ桁に揃える必要がある。Aave の金利が装飾で
  あるのと同じく、LST の利回りも装飾にする
- `config/lst.yaml` / `config/regimes/lst.yaml`（venue 単体検証、公式セット外）は 3600 を明示したまま残す。
  短い run で利回りを見えるようにするための圧縮で、公式の世界とは別だとファイルに書いた
- deployer が state dump に焼く値（3600）は変えない。coordinator が admin を vault の operator として持つ限り
  setup で上書きされる。持たないチェーン（`chainMode: external` で operator 登録が無い等）は従来どおり警告して
  焼いた値を継承する

## Consequences

- 公式の LST の利回りは 1 エポック ~0.007bps（8 WETH で ~$0.02）でガス未満。LST venue に残る技能は discount の裁定・
  slash（今は公式に無い）・レバレッジのリスクで、利回りのキャリーではない
- `lst-carry` は `yieldPerBlockBps × blocksRemaining` を入口コストと比べるので、公式ではステークしなくなる（discount が
  開いたときだけ動く）。参照 agent の挙動として正しい
- 練習期間の利回りは 1 日 ~0.8bps。報酬原資 50 WETH は 35 日の期間でステーク ~17,000 WETH まで持つので、issue #129 の
  「原資が尽きる」は事実上起きない（検出の仕組みは残る）
- **これ以前の run とは LST を持つ agent の P が比べられない**（公式で 1 エポック最大 ~13bps of V_0 の差）
- ADR 0026 §5 の懸念 3（エポックを伸ばすと LST の利回りが 200 日分になる）は消える
