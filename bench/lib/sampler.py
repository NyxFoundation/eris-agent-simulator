#!/usr/bin/env python3
"""Sample `docker stats` for eris-* containers to CSV until they all exit.
Usage: sampler.py OUT.csv [max_seconds]"""
import subprocess, time, sys, re

out = sys.argv[1]
max_s = int(sys.argv[2]) if len(sys.argv) > 2 else 1200

def mib(s):
    s = s.strip()
    if s.endswith("GiB"): return float(s[:-3]) * 1024
    if s.endswith("MiB"): return float(s[:-3])
    if s.endswith("KiB"): return float(s[:-3]) / 1024
    return float(re.sub(r"[A-Za-z]", "", s) or 0)

seen = False
t0 = time.time()
with open(out, "w") as f:
    f.write("ts,name,mem_mib,cpu_pct\n")
    while True:
        ts = int(time.time())
        r = subprocess.run(["docker", "stats", "--no-stream", "--format",
                            "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}"],
                           capture_output=True, text=True)
        lines = [l for l in r.stdout.splitlines() if l.startswith("eris-")]
        if lines: seen = True
        for l in lines:
            try:
                name, mem, cpu = l.split("|")
                memu = mem.split("/")[0].strip()
                f.write("%d,%s,%.1f,%s\n" % (ts, name, mib(memu), cpu.strip().rstrip("%")))
            except Exception:
                pass
        f.flush()
        n = subprocess.run(["docker", "ps", "-q", "--filter", "name=eris-"],
                           capture_output=True, text=True)
        if seen and not n.stdout.strip(): break
        if time.time() - t0 > max_s: break
        time.sleep(3)
print("sampler done:", out)
