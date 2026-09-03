#!/usr/bin/env python3
"""Summarize the improve-loop behaviour of a realtime run for load-test coverage (docs/23).
Reads runs/<id>/agents/*.jsonl (revision outcomes + actions + mempool) and events.jsonl (round_timing).
  improve-agg.py <run-dir> [block-budget-ms=2000]
The revision outcomes (installed/declined/rejected-by-reason/reverted) are the "process the LLM output"
signal that frozen/bench-max never exercise; round_timing max vs budget + lag is the block-time signal."""
import sys, os, json, glob, re
from collections import Counter

run = sys.argv[1]
budget = float(sys.argv[2]) if len(sys.argv) > 2 else 2000.0

outcomes = Counter()          # installed/declined/reverted
reject_reasons = Counter()
submitted = 0
actions = Counter()           # action type distribution (noop vs trades)
improving_agents = set()

# Revision records embed the generated strategy source (multi-line), so parse the whole file with
# regex rather than line-by-line JSON. record() writes {"kind":...,"reason":...} with kind first.
OUT_RE = re.compile(r'"kind":"(installed|declined|rejected|reverted)"')
REJ_RE = re.compile(r'"kind":"rejected","reason":"((?:[^"\\]|\\.){0,56})')
for af in glob.glob(os.path.join(run, "agents", "*.jsonl")):
    aid = os.path.basename(af)[:-6]
    txt = open(af, errors="ignore").read()
    got = OUT_RE.findall(txt)
    if got: improving_agents.add(aid)
    for k in got: outcomes[k] += 1
    for r in REJ_RE.findall(txt): reject_reasons[r] += 1
    submitted += txt.count('"event":"submitted"')
    for m in re.findall(r'"action":\{"type":"([a-zA-Z_]+)"', txt): actions[m] += 1

# round_timing from events.jsonl (boundary blocks only carry non-zero *Ms)
tmax = tp95 = lagmax = 0.0
tot = []
ev = os.path.join(run, "events.jsonl")
if os.path.exists(ev):
    for ln in open(ev, errors="ignore"):
        if '"round_timing"' not in ln: continue
        try: o = json.loads(ln)
        except Exception: continue
        t = float(o.get("totalMs", 0)); tot.append(t)
        lagmax = max(lagmax, float(o.get("blocksCaughtUp", 0)))
if tot:
    s = sorted(tot); tmax = s[-1]; tp95 = s[min(len(s) - 1, int(0.95 * len(s)))]

rev_total = sum(outcomes.values())
print(f"== improve summary: {os.path.basename(run)} ==")
print(f"improving agents      {len(improving_agents)}")
print(f"revisions (total {rev_total})  installed {outcomes['installed']}  declined {outcomes['declined']}  rejected {outcomes['rejected']}  reverted {outcomes['reverted']}")
if rev_total:
    print(f"install rate          {100*outcomes['installed']/rev_total:.0f}%")
for r, n in reject_reasons.most_common():
    print(f"  reject: {n:>3}x  {r}")
print(f"submitted txs         {submitted}")
print(f"action types          {dict(actions)}")
print(f"round_timing (ms)     max {tmax:.0f}  p95 {tp95:.0f}  budget {budget:.0f}  -> {'OK' if tmax<=budget else 'OVER'} ({100*tmax/budget:.0f}% of budget)")
print(f"max blocksCaughtUp    {lagmax:.0f}  ({'no lag' if lagmax<=1 else 'LAGGING'})")
