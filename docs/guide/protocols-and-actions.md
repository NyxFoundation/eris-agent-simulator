[← README](../../README.md)

# プロトコルとアクション

各アダプタ（`sdk/src/protocols/<name>.ts`）は parse / validate・calldata 構築（buildTxs）・観測（readState / observe）・PnL 評価（valueUsdc）・setup フックを実装する（orderflow の生成は環境側 `core/src/flow/` の仕事）。有効プロトコルは config の `run.protocols`（YAML 配列）か CLI フラグ `--protocols uniswap,balancer,curve,aave,gmx` で run ごとに選ぶ。エージェントの JSON アクション:

| プロトコル | アクション | venue（fork = Arbitrum / local = deployer デプロイ） |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees` | fork: WETH/USDC 0.05% プール / local: WETH/USDC 0.3% プール |
| Balancer v2 | `balancerSwap` | fork: 33/33/34 WETH/USDC/USDT weighted（フォーク時に seed）/ local: 50/50 WETH/USDC |
| Curve | `curveSwap` | fork: tricrypto WETH↔USDT / local: twocrypto-ng WETH/USDC |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | native USDC / WETH リザーブ |
| GMX v2 | `gmxIncrease`, `gmxDecrease` | ETH/USD perp market |

表は WETH 既定の market。ローカルデプロイで WBTC leg（`MARKET_LEGS`）がデプロイされていれば、同じアクションに `base: "WBTC"` を付与して WBTC/USDC spot・GMX WBTC market・Aave WBTC reserve も扱える（マルチアセット。ADR 0013）。

加えてプロトコル非依存の `noop` / `bundle`（複数の bundle 可能な leaf を 1 tx に）/ `rawTx` / `rawBundle` がある。

> アクションは JSON で表現する。`bundle` は bundle 可能な leaf をまとめて 1 tx で送る（GMX は非同期のため単独のみ）。`rawTx` / `rawBundle` で生 calldata も送れる。1 ラウンドあたりの取引量上限（config の `limits`: `agentWethWei` / `agentUsdcUnits` / `agentBase`）は **semantic action の事前検証**として掛かる — `rawTx` / `rawBundle` は calldata を解釈しないため金額上限の対象外（priority fee と bundle 件数のみ検証し、fee 違反は事後検出 = `postRunCheck` で `violations` に記録）。

## ステーブルコイン会計

Arbitrum の深い WETH/stable 流動性は USDC.e / USDT プールにあるため、native USDC・USDC.e・USDT はすべて `$1`・6 桁の **USDC 相当**として残高・PnL を合算する（`sdk/src/chain.ts` の `setActiveStables` / `getBalances`）。Uniswap / Aave / GMX は native USDC、Balancer は native USDC（プールをフォーク時に seed）、Curve は fork では USDT・local では USDC を使う。

## オラクル制御（Aave v3 / GMX v2）

モックオラクル（`contracts/MockAggregator.sol` / `contracts/MockOracleProvider.sol`）を setup でデプロイする（ローカルデプロイでは deployer の venue に同様に接続する）。Aave はコーディネータが ACL admin を impersonate して `AaveOracle` をモックに向け、GMX は `ROLE_ADMIN` を impersonate して keeper / controller ロールを付与し `DataStore` にモックプロバイダを登録する。毎ラウンド `updateOracles` が fair price を両モックへ書き込み、貸借のヘルスファクタと perp のマーク価格が動く。ローカルデプロイで stress victim を建てる run は、victim setup の前に Aave オラクルを初期 fair price へ較正する（[市場ストレスイベント](stress-events.md)）。

## GMX の非同期実行

GMX は非同期（注文作成 → keeper 実行）。realtime では毎ブロック interval mining で進み、コーディネータは各ブロック後（`afterMine`）に直近ブロックの `OrderCreated` ログを読んで各注文を keeper として執行する。ブロック内順序は anvil の `--order fees`（priority fee 降順）で決まる。GMX のポジション変化はエージェントに約 1 ブロック遅れて見える。GMX アクションは単独のみ（bundle 不可）。
