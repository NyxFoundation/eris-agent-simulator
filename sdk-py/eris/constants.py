"""The venue and token addresses of the local deployment -- the same table TypeScript reads.

TypeScript strategies get these from ``@eris/sdk/constants.js``, which overlays
``sdk/src/constants.local.ts`` when ``ERIS_LOCAL_DEPLOY=1``. This module reads that same file, so a
Python strategy and the host runtime that signs for it can never disagree about an address. The file
is generated (``npm run gen:local-constants``); in the live week's agent image it is regenerated from
the production state dump, and the image build refuses a file that names another deployment.

    from eris.constants import local_deployment, stable_market_legs, token_address

    weth = token_address("WETH")
    pool = local_deployment()["MARKET_LEGS"]["uniswap"]["WETH"]["pool"]
    eusd_pool = stable_market_legs()["EUSD"]["pool"]

Keys are the TypeScript ones (``TOKENS``, ``UNISWAP``, ``MARKET_LEGS``, ``poolId``, ...); see the
``LocalDeployment`` type at the top of the file for the shape. ``TOKENS`` includes ``EUSD`` as
TypeScript's registry does. The functions mirror ``constants.ts`` under snake_case names
(``token_address``, ``token_decimals``, ``symbol_for_address``, ``stable_market_legs``,
``require_lst``, ``require_liquity``, ``require_redemption_helper``, ``require_eusd_market``); a
``require_*`` that finds nothing raises :class:`ConstantsError` where TypeScript throws. Sections a
deployment does not have (``LST``, ``LIQUITY``, the ``WBTC`` entries) are absent, not empty. Per-run contracts -- PriceFeed,
MarketRegistry -- are not here; they arrive in the environment (``ERIS_PRICE_FEED_ADDRESS``,
``ERIS_MARKET_REGISTRY_ADDRESS``).

Anything that keeps the table from being read raises :class:`ConstantsError` rather than returning
an empty or partial table: an agent trading against a guessed address is worse than one that stops.
"""

from __future__ import annotations

import copy
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

__all__ = [
    "ConstantsError",
    "constants_path",
    "deployments_fingerprint",
    "local_deployment",
    "require_eusd_market",
    "require_liquity",
    "require_lst",
    "require_redemption_helper",
    "stable_market_legs",
    "symbol_for_address",
    "token_address",
    "token_decimals",
]

PathArg = str | os.PathLike[str] | None


class ConstantsError(RuntimeError):
    """The local deployment table is missing, not in use, or not readable."""


def constants_path() -> Path:
    """Where the table is: ``sdk/src/constants.local.ts`` next to this package's ``sdk-py``.

    The host puts ``sdk-py`` on ``PYTHONPATH`` beside ``sdk`` -- in the repository and in the agent
    image (``/eris/sdk-py`` and ``/eris/sdk``) alike -- so this resolves to the file the host itself
    loaded. A copy of the package installed elsewhere (``pip install ./sdk-py`` into a venv and run
    without the host) has no ``sdk`` next to it; pass ``path=`` there.
    """
    return Path(__file__).resolve().parents[2] / "sdk" / "src" / "constants.local.ts"


def local_deployment(path: PathArg = None) -> dict[str, Any]:
    """The ``LOCAL_DEPLOYMENT`` table as a dict (a fresh copy on every call).

    ``TOKENS`` is the registry TypeScript's ``TOKENS`` is: the generated tokens plus ``EUSD`` when
    the deployment has Liquity (eUSD is issued by the CDP, so the generator files it under
    ``LIQUITY.eusd`` and ``constants.ts`` adds it to the registry).
    """
    return copy.deepcopy(_table(path))


def token_address(symbol: str, *, path: PathArg = None) -> str:
    """``tokenAddress``: the address of a registry token (``KeyError`` for an unknown symbol)."""
    return _token(symbol, path)["address"]


def token_decimals(symbol: str, *, path: PathArg = None) -> int:
    """``tokenDecimals``: the decimals of a registry token (``KeyError`` for an unknown symbol)."""
    return _token(symbol, path)["decimals"]


def symbol_for_address(address: str, *, path: PathArg = None) -> str | None:
    """``symbolForAddress``: ``"WETH"`` or ``"USDC"`` for those two addresses, else ``None``.

    Like the TypeScript function it knows only the two quote/base tokens every run has; for the
    rest, search ``local_deployment()["TOKENS"]``.
    """
    tokens = _table(path)["TOKENS"]
    lower = address.lower()
    for symbol in ("WETH", "USDC"):
        if lower == tokens[symbol]["address"].lower():
            return symbol
    return None


def stable_market_legs(*, path: PathArg = None) -> dict[str, dict[str, Any]]:
    """``STABLE_MARKET_LEGS``: the stables priced from a market, keyed by registry symbol.

    Each leg is ``{pool, stableIndex, quoteIndex, venue}``. ``EUSD`` comes from the Liquity
    deployment's eUSD/USDC pool (venue ``liquity``); the generated ``STABLE_MARKETS`` (DAI) have
    venue ``curve``. A deployment without them returns ``{}``.
    """
    table = _table(path)
    out: dict[str, dict[str, Any]] = {}
    liquity = table.get("LIQUITY")
    if (
        liquity
        and liquity.get("eusdUsdcPool")
        and liquity.get("eusdIndex") is not None
        and liquity.get("usdcIndex") is not None
    ):
        out["EUSD"] = {
            "pool": liquity["eusdUsdcPool"],
            "stableIndex": liquity["eusdIndex"],
            "quoteIndex": liquity["usdcIndex"],
            "venue": "liquity",
        }
    for symbol, leg in (table.get("STABLE_MARKETS") or {}).items():
        out[symbol] = {**leg, "venue": "curve"}
    return copy.deepcopy(out)


def require_lst(*, path: PathArg = None) -> dict[str, Any]:
    """``requireLst``: the LST deployment, or ``ConstantsError`` when this deployment has none."""
    lst = _table(path).get("LST")
    if not lst:
        raise ConstantsError("the lst venue is not deployed in this environment")
    return copy.deepcopy(lst)


def require_liquity(*, path: PathArg = None) -> dict[str, Any]:
    """``requireLiquity``: the Liquity deployment, or ``ConstantsError`` when it has none."""
    liquity = _table(path).get("LIQUITY")
    if not liquity:
        raise ConstantsError("the liquity venue is not deployed in this environment")
    return copy.deepcopy(liquity)


def require_redemption_helper(*, path: PathArg = None) -> str:
    """``requireRedemptionHelper``: the LiquityRedemptionHelper address.

    Redemption hints must be computed inside the transaction (the oracle moves every block), so a
    deployment without the helper has no working redemption; that raises rather than returning None.
    """
    helper = require_liquity(path=path).get("redemptionHelper")
    if not helper:
        raise ConstantsError("this liquity deployment has no LiquityRedemptionHelper")
    return helper


def require_eusd_market(*, path: PathArg = None) -> dict[str, Any]:
    """``requireEusdMarket``: ``{pool, eusdIndex, usdcIndex, stable}`` of the eUSD/USDC pool."""
    liquity = require_liquity(path=path)
    if (
        not liquity.get("eusdUsdcPool")
        or liquity.get("eusdIndex") is None
        or liquity.get("usdcIndex") is None
        or not liquity.get("stable")
    ):
        raise ConstantsError("the liquity deployment has no eUSD/USDC market")
    return {
        "pool": liquity["eusdUsdcPool"],
        "eusdIndex": liquity["eusdIndex"],
        "usdcIndex": liquity["usdcIndex"],
        "stable": liquity["stable"],
    }


def deployments_fingerprint(path: PathArg = None) -> str:
    """``DEPLOYMENTS_FINGERPRINT``: which deployment the table was generated from (``sha256:...``)."""
    return _parse(str(_resolve(path)))[1]


def _token(symbol: str, path: PathArg) -> dict[str, Any]:
    tokens = _table(path)["TOKENS"]
    if symbol not in tokens:
        raise KeyError(f"{symbol!r} is not a registry token here (have {', '.join(tokens)})")
    return tokens[symbol]


def _table(path: PathArg) -> dict[str, Any]:
    """The cached table with the registry additions; callers must copy what they hand out."""
    if os.environ.get("ERIS_LOCAL_DEPLOY") != "1":
        raise ConstantsError(
            "ERIS_LOCAL_DEPLOY is not 1, so the host is not using the local deployment table either "
            "(TypeScript ignores constants.local.ts in that case). The competition environments all "
            "set it; for a hand-run test, export ERIS_LOCAL_DEPLOY=1"
        )
    return _registry(str(_resolve(path)))


@lru_cache(maxsize=4)
def _registry(path: str) -> dict[str, Any]:
    table = copy.deepcopy(_parse(path)[0])
    eusd = (table.get("LIQUITY") or {}).get("eusd")
    if eusd:
        table["TOKENS"]["EUSD"] = {"address": eusd, "decimals": 18}
    return table


def _resolve(path: PathArg) -> Path:
    target = Path(path) if path is not None else constants_path()
    if not target.is_file():
        raise ConstantsError(
            f"no address table at {target}. The host runtime places sdk/ next to sdk-py/; "
            "outside it, pass local_deployment(path=...)"
        )
    return target.resolve()


_TABLE = re.compile(
    r"export const LOCAL_DEPLOYMENT\s*:[^=]*=\s*(\{.*?^\});", re.DOTALL | re.MULTILINE
)
_FINGERPRINT = re.compile(r'^export const DEPLOYMENTS_FINGERPRINT\s*=\s*"([^"]*)";', re.MULTILINE)
_COMMENT = re.compile(r"^\s*//.*$", re.MULTILINE)
_CAST = re.compile(r"\s+as\s+(?:Address|`[^`]*`)")
_BIGINT = re.compile(r"\b(\d[\d_]*)n\b")
_NUMERIC_SEPARATOR = re.compile(r"(?<=\d)_(?=\d)")
_KEY = re.compile(r"([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:")
_TRAILING_COMMA = re.compile(r",(\s*[}\]])")


@lru_cache(maxsize=4)
def _parse(path: str) -> tuple[dict[str, Any], str]:
    text = Path(path).read_text(encoding="utf-8")
    fingerprint = _FINGERPRINT.search(text)
    table = _TABLE.search(text)
    if fingerprint is None or table is None:
        raise ConstantsError(
            f"{path} has no LOCAL_DEPLOYMENT table (null or an unknown layout). "
            "Regenerate it with npm run gen:local-constants"
        )
    # The generator writes a JSON-shaped object literal: full-line comments, `as Address` casts,
    # one bigint, bare keys and trailing commas are the only TypeScript in it.
    body = _COMMENT.sub("", table.group(1))
    body = _CAST.sub("", body)
    body = _BIGINT.sub(lambda m: m.group(1), body)
    body = _NUMERIC_SEPARATOR.sub("", body)
    body = _KEY.sub(r'\1"\2":', body)
    body = _TRAILING_COMMA.sub(r"\1", body)
    try:
        value = json.loads(body)
    except json.JSONDecodeError as err:
        raise ConstantsError(
            f"{path}: LOCAL_DEPLOYMENT is not in the layout gen:local-constants writes ({err})"
        ) from None
    if not isinstance(value, dict) or "TOKENS" not in value:
        raise ConstantsError(f"{path}: LOCAL_DEPLOYMENT has no TOKENS")
    return value, fingerprint.group(1)
