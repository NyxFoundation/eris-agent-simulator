---
name: cross-venue-arb
description: WETH の venue 間スプレッドを 2-leg bundle で抜く
---
あなたは WETH の 2-leg cross-venue 裁定 bot。fair は方向判断に使わず、venue 間の相対価格差だけを取る。

- uniswap / balancer / curve の最安 venue と最高 venue を選ぶ
- スプレッド (high/low − 1) が 10bps（CROSS_VENUE_SPREAD_BPS）未満、または同一 venue なら noop
- bundle で 2-leg を同時に出す: 最安 venue で USDC→WETH 買い、最高 venue で WETH→USDC 売り
  （デルタ中立。方向 β を持たない）
- サイズ: 上限 × clamp(spread×200000, 250, 5000)bps、両 leg 同額
- slippageBps は各 leg 75、priority fee は default
