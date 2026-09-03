#!/usr/bin/env python3
"""Aggregate the sampler CSV into fleet + PER-AGENT memory/CPU stats.
  Usage: agg.py STATS.csv [label] [--md]
Container name is eris-<id> (id == agent), so each container's series is that agent's footprint.
--md emits Markdown for a GitHub PR comment; otherwise plain text."""
import sys, csv
from collections import defaultdict

args = [a for a in sys.argv[1:] if a != "--md"]
md = "--md" in sys.argv
path = args[0]
label = args[1] if len(args) > 1 else path
per_mem, per_cpu = defaultdict(list), defaultdict(list)
by_ts = defaultdict(float)
rows = 0
with open(path) as f:
    for r in csv.DictReader(f):
        try:
            m, c, ts, n = float(r["mem_mib"]), float(r["cpu_pct"]), r["ts"], r["name"]
        except Exception:
            continue
        per_mem[n].append(m); per_cpu[n].append(c); by_ts[ts] += m; rows += 1

names = sorted(per_mem)
if not names:
    print("no samples in " + path); sys.exit(0)
def stats(n):
    mm, cc = per_mem[n], per_cpu[n]
    agent = n[5:] if n.startswith("eris-") else n
    return dict(agent=agent, mem_peak=max(mm), mem_mean=sum(mm) / len(mm), cpu_peak=max(cc))
rowsd = sorted((stats(n) for n in names), key=lambda d: d["mem_peak"], reverse=True)
peak = sorted(d["mem_peak"] for d in rowsd)
med = lambda a: a[len(a) // 2]
fleet_mem_gb = max(by_ts.values()) / 1024
gmax = peak[-1]

if md:
    print(f"### 🧪 bench — {label}\n")
    print("| metric | value |\n|---|---|")
    print(f"| agents (containers) | {len(names)} |")
    print(f"| per-agent mem peak (MiB) | min {peak[0]:.0f} · median {med(peak):.0f} · max {gmax:.0f} |")
    print(f"| fleet peak mem | {fleet_mem_gb:.1f} GB |")
    print(f"| projection to 100 (worst {gmax:.0f} MiB) | {gmax * 100 / 1024:.1f} GB |")
    print("\n<details><summary>per-agent CPU / memory</summary>\n")
    print("| agent | mem peak MiB | mem mean MiB | cpu peak % |\n|---|--:|--:|--:|")
    for d in rowsd:
        print(f"| `{d['agent']}` | {d['mem_peak']:.0f} | {d['mem_mean']:.0f} | {d['cpu_peak']:.1f} |")
    print("\n</details>")
else:
    print(f"== {label} ==  agents={len(names)} samples={rows}")
    print(f"fleet peak mem: {fleet_mem_gb:.1f} GB   per-agent mem peak: min {peak[0]:.0f} / med {med(peak):.0f} / max {gmax:.0f} MiB")
    print(f"{'agent':<20}{'mem_peak':>10}{'mem_mean':>10}{'cpu_peak':>10}")
    for d in rowsd:
        print(f"{d['agent']:<20}{d['mem_peak']:>10.0f}{d['mem_mean']:>10.0f}{d['cpu_peak']:>10.1f}")
