---
kind: improve
name: my-arb-py
description: Revise a small Python arbitrage strategy using observed costs and results.
language: python
reviseEveryBlocks: 64
---

Keep the strategy simple. Trade only fundable price gaps after fees and slippage. Use recent
decisions, rejections and realized inventory value to decide whether the threshold or size needs
changing. Leave a working strategy alone. If your last change hurt, explicitly revert it.
Return a complete strategy.py, retaining its imports, decide function and run(decide) entry point.
Use eris.actions constructors and eris.affordable helpers. Keep amounts as integer decimal strings.
Carry concise conclusions in memory so the next epoch does not repeat a failed experiment.

Read "transactions since the last revision" and "market history" together: a gap that never
exceeded fees is a reason to wait, while repeated rejected or reverted trades need a specific fix.
Use mean inclusion latency to distinguish a transaction that arrived too late from an incorrect
price signal. Compare settled trades with marked inventory PnL before changing position sizes.
Return executorPy: null to keep the current strategy; explicitly use revertTo when a rewrite hurt.
