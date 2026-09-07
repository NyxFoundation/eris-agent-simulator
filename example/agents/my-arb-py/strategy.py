"""Python port of my-arb: buy/sell the largest fundable gap, spending 10%."""

import math
from eris import Context, Observation, run
from eris.actions import swap, balancer_swap, curve_swap, noop
from eris.affordable import can_fund, sized


def decide(obs: Observation, ctx: Context):
    venues = [
        (
            swap,
            (
                obs.protocols.uniswap.pool.price_usdc_per_weth
                if obs.protocols.uniswap
                else None
            ),
        ),
        (
            balancer_swap,
            (
                obs.protocols.balancer.price_usdc_per_weth
                if obs.protocols.balancer
                else None
            ),
        ),
        (
            curve_swap,
            obs.protocols.curve.price_usdc_per_weth if obs.protocols.curve else None,
        ),
    ]
    best = None
    best_gap = 0.001
    for constructor, price in venues:
        if price is None or not math.isfinite(price) or price <= 0:
            continue
        token_in = "USDC" if price < obs.fair_price_usdc_per_weth else "WETH"
        gap = abs(obs.fair_price_usdc_per_weth / price - 1)
        if gap > best_gap and can_fund(obs, token_in):
            best = constructor, token_in
            best_gap = gap
    if best is None:
        return noop(reason="no fundable gap worth taking")
    constructor, token_in = best
    amount = sized(obs, token_in, 1000)
    if amount == 0:
        return noop(reason="size below the floor")
    return constructor(
        token_in=token_in,
        amount_in=str(amount),
        slippage_bps=75,
        max_priority_fee_per_gas_wei=obs.limits.default_priority_fee_per_gas_wei,
    )


if __name__ == "__main__":
    run(decide)
