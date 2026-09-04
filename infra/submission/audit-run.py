#!/usr/bin/env python3
"""Post-run integrity + abuse audit (ASCON 4.12).

Reads a finished run's artifacts and checks that the on-chain enforcement actually held, and flags
abuse signals for review. Runs after a scored run (docs/24 §4 "後処理の機械チェック", docs/21).

HARD violations (exit 2 — the run should be invalidated): the operator-side enforcement was bypassed.
  - tx cap:        an agent submitted more than N tx in a single round (§2.6, default N=3).
  - priority-fee:  agent tx within a block are not ordered by priority fee (§2.6 auction failed).
WARN signals (exit 0 — for manual review, not auto-invalidation):
  - revert spam:   an agent's tx revert rate is high (resource abuse).
  - collusion:     a pair of agents repeatedly make opposing swaps in the same round (wash/collusion
                   heuristic). NOT proof — legit arbitrage also trades against the flow; it points a
                   reviewer at pairs to inspect. Full inter-team detection needs the registration
                   team->wallet map + net value-flow, which live outside a single run's artifacts.

Usage: audit-run.py <run_dir> [--max-tx 3] [--revert-warn 0.5] [--collusion-warn 0.6] [--json]
"""
import csv, json, sys, os, glob, argparse
from collections import defaultdict


def load_blocks(run_dir):
    p = os.path.join(run_dir, "blocks.csv")
    if not os.path.exists(p):
        raise SystemExit(f"no blocks.csv in {run_dir} (run not finished / wrong dir)")
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def check_tx_cap(rows, max_tx):
    txs = defaultdict(set)  # (round, owner) -> {hash}  (a bundle is one hash = one tx)
    for r in rows:
        if r.get("role") == "agent":
            txs[(r["round"], r["ownerId"])].add(r["hash"])
    return [
        f"tx-cap: agent '{owner}' sent {len(h)} tx in round {rnd} (limit {max_tx})"
        for (rnd, owner), h in sorted(txs.items()) if len(h) > max_tx
    ]


def check_priority_fee(rows):
    # §2.6: within a block, agent tx must be ordered by priority fee (desc). System/flow tx are the
    # environment's and are placed first by design, so only agent-vs-agent ordering is the auction.
    byblock = defaultdict(list)
    for r in rows:
        if r.get("role") == "agent":
            byblock[r["blockNumber"]].append(r)
    viol = []
    for bn, br in byblock.items():
        br.sort(key=lambda r: int(r["txIndex"]))
        for a, b in zip(br, br[1:]):
            if int(b["priorityFeeWei"]) > int(a["priorityFeeWei"]):
                viol.append(
                    f"priority-fee: block {bn} tx#{a['txIndex']}({a['priorityFeeWei']}) before "
                    f"tx#{b['txIndex']}({b['priorityFeeWei']}) — not fee-ordered"
                )
    return viol


def check_revert(rows, warn):
    tot = defaultdict(int); bad = defaultdict(int)
    for r in rows:
        if r.get("role") == "agent":
            tot[r["ownerId"]] += 1
            if r.get("status") != "success":
                bad[r["ownerId"]] += 1
    out = []
    for owner, n in sorted(tot.items()):
        rate = bad[owner] / n if n else 0
        if rate >= warn and bad[owner] >= 3:
            out.append(f"revert-spam: agent '{owner}' {bad[owner]}/{n} tx reverted ({rate:.0%})")
    return out


def check_collusion(run_dir, warn):
    # Heuristic: for each round, record each agent's net swap direction (buy WETH vs sell WETH).
    # Count, per unordered agent pair, rounds where both traded and took OPPOSITE directions.
    # A pair that is opposite in a high fraction of their shared active rounds is flagged for review.
    dirs = defaultdict(dict)  # round -> {agent: +1 buy / -1 sell}
    for f in glob.glob(os.path.join(run_dir, "agents", "*.jsonl")):
        agent = os.path.basename(f)[:-6]
        if agent.endswith(".llm"):
            continue
        for line in open(f):
            try:
                e = json.loads(line)
            except Exception:
                continue
            act = e.get("action") or {}
            legs = act.get("actions") if act.get("type") == "bundle" else [act]
            net = 0
            for a in legs or []:
                if a.get("type") == "swap":
                    ti = str(a.get("tokenIn", "")).upper()
                    net += 1 if ti in ("USDC", "USDT", "DAI") else (-1 if ti == "WETH" else 0)
            if net and "round" in e:
                dirs[e["round"]][agent] = 1 if net > 0 else -1
    shared = defaultdict(int); opp = defaultdict(int)
    for rnd, d in dirs.items():
        ags = sorted(d)
        for i in range(len(ags)):
            for j in range(i + 1, len(ags)):
                pair = (ags[i], ags[j])
                shared[pair] += 1
                if d[ags[i]] != d[ags[j]]:
                    opp[pair] += 1
    out = []
    for pair, n in sorted(shared.items()):
        if n >= 5 and opp[pair] / n >= warn:
            out.append(
                f"collusion?: '{pair[0]}' and '{pair[1]}' took opposite swap directions in "
                f"{opp[pair]}/{n} shared rounds ({opp[pair]/n:.0%}) — review for wash trading"
            )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--max-tx", type=int, default=int(os.environ.get("ERIS_MAX_TXS_PER_ROUND", "3")))
    ap.add_argument("--revert-warn", type=float, default=0.5)
    ap.add_argument("--collusion-warn", type=float, default=0.6)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rows = load_blocks(a.run_dir)
    hard = check_tx_cap(rows, a.max_tx) + check_priority_fee(rows)
    warn = check_revert(rows, a.revert_warn) + check_collusion(a.run_dir, a.collusion_warn)

    if a.json:
        print(json.dumps({"run": a.run_dir, "hard": hard, "warn": warn,
                          "verdict": "INVALIDATE" if hard else "OK"}, ensure_ascii=False, indent=2))
    else:
        print(f"=== audit: {a.run_dir} ===")
        for h in hard: print(f"  [HARD] {h}")
        for w in warn: print(f"  [WARN] {w}")
        print(f"--- {len(hard)} hard / {len(warn)} warn -> {'INVALIDATE run' if hard else 'OK'}")
    sys.exit(2 if hard else 0)


if __name__ == "__main__":
    main()
