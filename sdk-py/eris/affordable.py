"""Wallet-based sizing; amounts remain Python integers, never floats."""

import math
from .observation import AgentObservation


def minimum_for(token_in: str) -> int:
    return 1_000_000 if token_in == "USDC" else 1_000_000_000_000_000


def balance_of(obs: AgentObservation, token_in: str) -> int:
    if token_in == "USDC":
        return int(obs.balances.usdc_units)
    if token_in == "WETH":
        return int(obs.balances.weth_wei)
    stable = (obs.balances.stables or {}).get(token_in)
    if stable is not None:
        return int(stable.balance)
    return int((obs.base_balances or {}).get(token_in, "0"))


def affordable(obs: AgentObservation, token_in: str, desired: int) -> int:
    spendable = min(desired, balance_of(obs, token_in))
    return spendable if spendable >= minimum_for(token_in) else 0


def sized(obs: AgentObservation, token_in: str, fraction_bps: float) -> int:
    # Match Math.round (ties toward +infinity), not Python's ties-to-even round.
    bps = max(0, min(10_000, math.floor(fraction_bps + 0.5)))
    return affordable(obs, token_in, balance_of(obs, token_in) * bps // 10_000)


def can_fund(obs: AgentObservation, token_in: str) -> bool:
    return balance_of(obs, token_in) >= minimum_for(token_in)
