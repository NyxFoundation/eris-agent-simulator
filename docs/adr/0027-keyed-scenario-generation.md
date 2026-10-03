# ADR 0027: シナリオの実現値を運営の秘密鍵で決める

## Status

Accepted（2026-09-28）。同じ PR で実装した。規約（ascon-web `content/legal/rules.md`）の §3.3・§4.4.3・§7.1・§7.2
の改定を伴う（別 PR）。

## Context

規約は非公開セットについて 3 つの性質を約束している（§3.3・§4.4.3・§7.1・§7.2）。

- **(a) 事前に分からない**: 参加者はライブ週の各エポックのシナリオを事前に知らない
- **(b) 運営が選ばない**: seed と抽選用 seed は、使う前にハッシュを公表し、結果発表後に原本を公開する。運営は結果を見て
  シナリオを選べない
- **(c) 事後に再現できる**: 原本の公開後は、誰でも同じ評価を再現できる

今のシナリオの実現値（価格の walk・背景フロー・ストレスイベントの配置・vuln のプール・LST の APY など）は、**seed だけを
入力とする決定論的な乱数列**から作られる。乱数生成器（`sdk/src/rng.ts`）は統計的な用途のためのもので、「出力の系列から
後続の出力を推定されない」という暗号学的な性質は持たない。seed 自体も小さな整数である。

つまり (a) は「seed が秘密であること」だけに支えられていて、それを補う仕組みが無い。一方でライブ週のエージェントは、
各エポックの 360 ブロックのあいだ環境の出力（価格・フロー・イベント）を観測し続ける。

要求は次のとおり: **実現値は結果発表まで、公開情報（コード・公開 regime・チェーン上の全データ）から導けないこと。**
しかも (b) と (c) を保つこと。

## Decision

### 1. 乱数列を鍵付き擬似乱数関数（PRF）から取る

`Rng` の逐次 API（`next()` / `gaussian()` / `poisson()` など）は変えず、中身を counter モードの PRF にする。

```
u_i = PRF(K, streamId, i)      // 例: HMAC-SHA256(K, streamId || i) の先頭 53 bit を [0, 1) に写す
```

- `streamId` は「seed と用途」（`price:WETH`・`flow`・`stress`・`vuln`・`lst` …）から作る。各用途が今持っている salt と
  seed のハッシュ（#145 の `mix32`、#150 の `Rng.fromSeed`）は、この `streamId` に吸収する
- **出力を何個見ても、K を知らなければ次の出力は分からない**。これが (a) を seed の秘密だけに頼らせない部分
- 性能: HMAC-SHA256 は 1 回 1µs 程度で、1 ブロックに数十回引いても無視できる

### 2. K は運営だけが持つ 256 bit の秘密

- repo・run ディレクトリ・エージェントに渡る設定のどこにも書かない。coordinator だけが読む
  （練習期間の `ERIS_PRACTICE_SEED` と同じく、git 管理外の秘密ファイルに置く）
- エージェントのプロセスとコンテナには渡さない。「エージェントには必要なものだけを見せる」変更（別 PR）と同じ線引き

### 3. K の扱いは非公開 seed と同じ

- **提出締切（10/31）より前に K のハッシュを公表する**（`npm run competition -- commit` と同じ正規化 JSON の sha256）
- 結果発表後に原本を公開する
- 締切より前に固定するので、運営が提出物を見てから K を選ぶことはできない（(b)）。原本の公開で誰でも再現できる（(c)）

### 4. 公開セットの K は公開値

- 固定の公開鍵（例: 文字列 `eris-public-v1` の SHA-256）を repo に置き、参加者が公開セットを手元で再現できるようにする
- 秘密の K を使うのは非公開セット（ライブ週）だけ
- backtest は `--scenario-key <file>` で K を受け取り、指定が無ければ公開鍵を使う
- `matrix.json` に鍵の commitment（公開鍵の場合はその旨）を記録する

### 5. 練習期間も同じ機構を使う

期間の K を `.env.practice` に置く。公式採点ではないので、公開するかどうかは任意。次の再起動から適用する。

### 6. 実現値は変わる

#145・#150 で全公式レジームの実現値は既に変わっており、過去の数字とは比べられない。本変更も同じ扱いとし、公開鍵で
再現した値を新しい基準にする。

## 検討した代替案

| 案 | 判断 |
|---|---|
| seed を大きな乱数にするだけ | 統計用の生成器は、出力の系列から後続を推定されない性質を持たない。(a) を seed の秘密だけに頼る構造は変わらないので却下 |
| 生成器を暗号学的 PRNG（ChaCha20 など）に替え、seed を 256 bit にする | seed がそのまま鍵になるので本案と等価。ただし「seed = シナリオの名前、K = 秘密」を分ける本案の方が、公開セットの再現（seed を公開して K は公開値）と、既存の commitment の仕組み（seed 一覧のハッシュ）をそのまま使える |
| 全シナリオを事前に計算してファイルで配る | 再現性は保てるが、run 中のブロックごとの生成をすべて置き換えることになり、変更が大きい |

## Consequences

- 実装: `sdk/src/rng.ts` に鍵付きストリームを足し、呼び出し側は `streamId` を渡すだけにする
- 規約の改定:
  - §3.3: 非公開セットの生成に鍵を加える
  - §4.4.3: 再現には鍵が要る
  - §7.1: 鍵のハッシュの公表時期
  - §7.2: 鍵の原本の公開
- 運用: K の生成・保管・commitment の手順を運営向けガイドに書く。**K を失うと評価を再現できない**ので、seed と同じく
  バックアップを取る
- (a) が成り立つのは、エージェントに渡る情報の整理（別 PR）と本 ADR の両方がそろったとき

## 決定した未決事項（2026-09-28）

- **K のハッシュは実装のマージ直後に公表する**（10 月上旬）。提出締切 10/31 より前という条件のうち最も早い日で、
  問題があっても締切までに公表し直せる
- **公開鍵は `SHA-256("eris-public-v1")`**（`ab26c748…bb72f`。`sdk/src/rng.ts` の `PUBLIC_SCENARIO_KEY_HEX`、
  コミットメントは `sha256:5940f4fc…30d8e0`）

## 実装

- `sdk/src/rng.ts`: `Rng.fromSeed(seed, salt)` が鍵付きストリームを返す。1 ブロック =
  `HMAC-SHA256(K, "eris-rng/v1" || seed(u32) || salt(u32) || counter(u64))` を 8 バイトずつ 53 bit の [0, 1) に写す。
  `new Rng(x)`（LCG）は鍵と無関係な用途（agent 側の `ctx.rng`・actor のサイズ）に残る。ストリームは作られた時点の鍵を持つ
- 鍵を通るもの: 価格の walk（全 base）・prewarm・flow bot（`flowRng` / `trendRng`）・stress のスケジュール
  （variation キーを使う列はイベント列も salt に混ぜる = #145 の規則を維持）・LST の APY・vuln のスケジュール
- `core/src/scenarioKey.ts`: 鍵ファイルは `{ scenarioKey: <64 hex> }` の 1 フィールドだけ（他のフィールドがあると
  同じ鍵に 2 つのコミットメントができるので拒否）。コミットメントは `npm run competition -- commit <file>` と同じ値
- 渡し方: `npm run backtest -- --scenario-key <file|public>`、または `ERIS_SCENARIO_KEY_FILE`（`sim:realtime` と
  練習期間の systemd）。どちらも無ければ公開鍵。**順序付きプラン（ライブ週の形）は鍵の指定が無いと起動しない**
  （公開鍵で黙って走るのを防ぐ。意図して公開鍵で回すときは `--scenario-key public`）
- **レジーム名もストリームの名前に入る**（issue #186 で追加）。`streamId` は
  `"eris-rng/v1" || seed || salt || len(regime)(u32) || regime(UTF-8)`（レジームが空なら従来どおり末尾なし）。
  それまでは stress のスケジュールだけがイベント列を salt に混ぜており、価格の walk・flow・LST・vuln・prewarm は
  (seed, salt) だけで決まっていたので、**同じ seed の calm と crash が同じ価格ショックと同じフローを引いていた**。
  非公開セットは全レジームに同じ seed 列を持たせるので、状態を引き継ぐ agent が別レジームで見た経路を照合できた。
  backtest が実効 regime YAML に `run.regime` を書き、coordinator が `setScenarioRegime` で入れ、flow bot には鍵と一緒に
  `ERIS_SCENARIO_REGIME` で渡す（agent には渡さない）。`sim:realtime` のようにレジームを名乗らない run は従来と同じ値を引く。
  記録は `run_started_realtime.scenarioRegime`
- coordinator は flow bot にファイルパスとコミットメントを渡し、flow bot は一致しなければ exit する。agent には渡さない
- 記録: `run_started_realtime.scenarioKey` と `matrix.json` の `scenarioKey`（`{ source, commitment }`）。
  `--resume` は鍵が違う、または鍵の記録が無い（本 ADR 以前の）matrix を拒否する
- K の生成: `npm run competition -- keygen <out.yaml>`（mode 0600・上書き拒否・コミットメントだけを出力）。
  **運営のマシンで実行する**

## 運用手順

1. 運営マシンで `npm run competition -- keygen <secret-dir>/scenario-key.yaml` を実行し、出力されたコミットメントを公表する。
   ファイルはバックアップする（**失うと評価を再現できない**）
2. ライブ週: `npm run backtest -- --scenarios <plan.yaml> --scenario-key <secret-dir>/scenario-key.yaml …`。
   `matrix.json` の `scenarioKey.commitment` が公表値と一致することを確認する
3. 結果発表後: 鍵ファイルを公開する。誰でも `competition commit` で公表値と照合し、`--scenario-key` で再現できる
4. 練習期間: 別の鍵を同じ手順で作り、`.env.practice` に `ERIS_SCENARIO_KEY_FILE=<path>` を足して次の再起動から適用する
