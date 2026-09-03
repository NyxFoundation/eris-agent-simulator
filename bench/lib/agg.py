#!/usr/bin/env python3
"""Aggregate the sampler CSV into per-container + fleet memory/CPU stats.
  Usage: agg.py STATS.csv [label] [--md]
--md emits a Markdown block suitable for a GitHub PR comment; otherwise plain text."""
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
peak = sorted(max(per_mem[n]) for n in names)
mean = sorted(sum(per_mem[n]) / len(per_mem[n]) for n in names)
cpud = sorted(max(per_cpu[n]) for n in names)
med = lambda a: a[len(a) // 2]
fleet_mem_gb = max(by_ts.values()) / 1024
gmax = peak[-1]
proj100 = gmax * 100 / 1024

if md:
    print(f"### 🧪 bench — {label}\n")
    print(f"| metric | value |\n|---|---|")
    print(f"| containers | {len(names)} |")
    print(f"| per-container mem peak (MiB) | min {peak[0]:.0f} · median {med(peak):.0f} · max {gmax:.0f} |")
    print(f"| per-container mem mean (MiB) | median {med(mean):.0f} |")
    print(f"| per-container cpu peak (%) | median {med(cpud):.1f} · max {cpud[-1]:.1f} |")
    print(f"| fleet peak mem | {fleet_mem_gb:.1f} GB |")
    print(f"| projection to 100 (worst peak {gmax:.0f} MiB) | {proj100:.1f} GB |")
else:
    print(f"== {label} ==  containers={len(names)} samples={rows}")
    print(f"per-container PEAK mem MiB : min={peak[0]:.0f} median={med(peak):.0f} max={gmax:.0f}")
    print(f"per-container MEAN mem MiB : median={med(mean):.0f}")
    print(f"per-container PEAK cpu %%  : median={med(cpud):.1f} max={cpud[-1]:.1f}")
    print(f"fleet PEAK mem GB         : {fleet_mem_gb:.1f}")
    print(f"projection to 100 (x{gmax:.0f} MiB) : {proj100:.1f} GB")
