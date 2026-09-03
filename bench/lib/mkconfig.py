#!/usr/bin/env python3
"""Bench config generator (repo-relative). N agents, each an example agent run in a memory/CPU-capped
container via infra/docker-agent/run-agent.sh. Agent #1 is a host-run noop baseline; #2..N are
dockerised venue-arb.
  Usage: mkconfig.py N BLOCKS BLOCK_TIME MODE OUT
  MODE = frozen (coded strategy, no LLM) | llm (improve loop -> Ollama gpt-oss:20b)
"""
import re, sys, os

N, BLOCKS, BT, MODE, OUT = sys.argv[1:6]
N = int(N)
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(REPO)

src = open("config/local.yaml").read()
head = src[:src.index("\nagents:")]
head = re.sub(r"^(\s*)blocks:\s*\d+", rf"\g<1>blocks: {BLOCKS}", head, flags=re.M)
secs = int(int(BLOCKS) * int(BT) * 1.5) + 300
head = re.sub(r"^(\s*)seconds:\s*\d+", rf"\g<1>seconds: {secs}", head, flags=re.M)
head = re.sub(r"^(\s*)blockTimeSec:\s*\d+", rf"\g<1>blockTimeSec: {BT}", head, flags=re.M)
head = head.replace("protocols: [uniswap, balancer, curve, lst, liquity]",
                    "protocols: [uniswap, balancer, curve, gmx, aave]")
# drop the liquity-dependent eusdDepeg stress; use a single crash event
m = re.search(r"\nstress:.*?(?=\n[a-z]|\Z)", head, flags=re.S)
crash = ("\nstress:\n  events:\n    - { type: crash, magnitudeRange: [0.12, 0.16], "
         "windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }")
head = head[:m.start()] + crash + head[m.end():] if m else head + crash

wrapper = os.path.join(REPO, "infra/docker-agent/run-agent.sh")
adir = os.path.join(REPO, "example/agents/venue-arb")
if MODE == "frozen":
    envline = '{ ERIS_AGENT_DIR: "' + adir + '", ERIS_AGENT_FROZEN: "1" }'
elif MODE == "llm":
    envline = '{ ERIS_AGENT_DIR: "' + adir + '", ERIS_LLM_MODEL: "gpt-oss:20b" }'
else:
    sys.exit("bad MODE " + MODE)

ag = "\nagents:\n  - id: noop\n    wallet: AGENT1_PRIVATE_KEY\n    baseline: true\n"
for k in range(2, N + 1):
    ag += ("  - id: arb-%03d\n    dir: venue-arb\n    wallet: AUTO\n"
           "    command: " + wrapper + "\n    env: " + envline + "\n") % k

open(OUT, "w").write(head + ag)
chk = open(OUT).read()
assert "gmx, aave" in chk and ("blockTimeSec: " + BT) in chk and chk.count("command: ") == N - 1
print("%s: %d agents (1 noop + %d docker/%s), blocks=%s bt=%s" % (OUT, N, N - 1, MODE, BLOCKS, BT))
