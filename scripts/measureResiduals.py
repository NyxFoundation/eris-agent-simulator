"""Compare post-run AMM residuals: python3 scripts/measureResiduals.py runs/<id> [...]."""

import argparse
import csv
import json
import math
import statistics
from pathlib import Path


def gap_bps(fair, mid):
    if not all(isinstance(x, (int, float)) and math.isfinite(x) and x > 0 for x in (fair, mid)):
        return None
    return (fair / mid - 1) * 10_000


def measure(run):
    market = json.loads((run / "market.json").read_text())
    series = market["series"]
    if not series:
        raise ValueError(f"{run}: empty market series")
    rows = {}
    for base in market["bases"]:
        for venue in market["venues"]:
            if not any(base in row.get("venues", {}).get(venue, {}) for row in series):
                continue
            gaps = [gap_bps(row["fair"].get(base), row.get("venues", {}).get(venue, {}).get(base, {}).get("mid"))
                    for row in series]
            values = [gap for gap in gaps if gap is not None]
            rows[f"{base}/{venue}"] = {
                "samples": len(values), "missingOrInvalid": len(gaps) - len(values),
                "meanBps": statistics.mean(values) if values else None,
                "stddevBps": statistics.pstdev(values) if values else None,
                "absAbove80BpsFraction": sum(abs(gap) > 80 for gap in values) / len(values) if values else None,
            }

    by_block = {row["block"]: row for row in series}
    mismatch, compared, missing = {}, 0, 0
    with (run / "blocks.csv").open(newline="") as source:
        for tx in csv.DictReader(source):
            owner = tx["ownerId"]
            if not owner.startswith("flow-") or not owner.endswith(":informed") or tx["status"] != "success":
                continue
            notional = market["notionals"].get(tx["hash"].lower(), {})
            base, side = notional.get("base"), notional.get("side")
            if side not in ("buy", "sell") or not base:
                continue
            venue = owner.removeprefix("flow-").removesuffix(":informed")
            block = int(tx["blockNumber"])
            current, previous = by_block.get(block), by_block.get(block - 1)
            gap = gap_bps(current["fair"].get(base), previous.get("venues", {}).get(venue, {}).get(base, {}).get("mid")) if current and previous else None
            if gap is None:
                missing += 1
                continue
            compared += 1
            # A diagnostic proxy for direction, not the exact pre-submission state: other trades
            # and delayed inclusion can change the pool after the previous block's sample.
            if (side == "buy" and gap < -30) or (side == "sell" and gap > 30):
                key = f"{base}/{venue}/{side}"
                mismatch[key] = mismatch.get(key, 0) + 1
    return {
        "run": run.name, "fromBlock": market["fromBlock"], "toBlock": market["toBlock"],
        "granularityBlocks": market["granularityBlocks"], "failedReads": market["failedReads"],
        "residuals": rows, "informedCompared": compared, "informedMissingSamples": missing,
        "directionMismatchVsPreviousMid": mismatch,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        print(json.dumps([measure(run) for run in args.runs], indent=2, allow_nan=False))
    except (OSError, ValueError, KeyError, TypeError, csv.Error, statistics.StatisticsError) as error:
        parser.exit(1, f"measureResiduals: {error}\n")
