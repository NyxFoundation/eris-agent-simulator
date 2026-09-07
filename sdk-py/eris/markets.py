"""The same executable quotes and legacy mid-price fallback as lib/markets.ts."""

from dataclasses import dataclass
from .observation import AgentObservation


@dataclass
class AgentVenue:
    protocol: str
    swap_type: str
    price: float
    fee_bps: float
    sell_price: float | None = None
    buy_price: float | None = None


@dataclass
class MarketView:
    base: str
    fair: float
    venues: list[AgentVenue]
    base_balance_wei: str
    base_decimals: int


def market_views(obs: AgentObservation) -> list[MarketView]:
    fairs = (
        obs.fair_prices_usd
        if obs.fair_prices_usd is not None
        else {"WETH": obs.fair_price_usdc_per_weth}
    )
    views = []
    for base in sorted(fairs, key=lambda value: (value != "WETH", value)):
        if not fairs[base] > 0:
            continue
        venues = []
        for protocol, swap_type in (
            ("uniswap", "swap"),
            ("balancer", "balancerSwap"),
            ("curve", "curveSwap"),
        ):
            venue = getattr(obs.protocols, protocol)
            if venue is None:
                continue
            quote = (
                (venue.pool if protocol == "uniswap" else venue)
                if base == "WETH"
                else (venue.markets or {}).get(f"{base}/USDC")
            )
            if quote is None or not quote.price_usdc_per_weth > 0:
                continue
            spread = getattr(quote, "effective_half_spread_bps", None)
            sell = getattr(quote, "sell_price_usdc_per_weth", None)
            buy = getattr(quote, "buy_price_usdc_per_weth", None)
            two_sided = (
                protocol != "uniswap"
                and spread is not None
                and spread >= 0
                and sell is not None
                and buy is not None
            )
            fee = getattr(quote, "fee", None)
            fee_bps = (
                spread
                if two_sided
                else (
                    fee / 100
                    if protocol == "uniswap" and fee is not None and fee > 0
                    else 30
                )
            )
            price = (
                quote.price_usdc_per_weth
                if protocol == "uniswap" or two_sided
                else quote.price_usdc_per_weth / (1 - fee_bps / 10000)
            )
            venues.append(
                AgentVenue(
                    protocol,
                    swap_type,
                    price,
                    fee_bps,
                    sell if two_sided else None,
                    buy if two_sided else None,
                )
            )
        if venues:
            balance = (
                obs.balances.weth_wei
                if base == "WETH"
                else (obs.base_balances or {}).get(base, "0")
            )
            views.append(
                MarketView(
                    base,
                    fairs[base],
                    venues,
                    balance,
                    int((obs.base_decimals or {}).get(base, 18)),
                )
            )
    return views
