#!/usr/bin/env python3
"""Bench config generator (repo-relative). Each competing agent runs in a memory/CPU-capped
container via infra/docker-agent/run-agent.sh; a host-run noop is the baseline.
  Usage: mkconfig.py BLOCKS BLOCK_TIME MODE OUT ROSTER
    ROSTER = <N>          -> N-1 clones of venue-arb (load test)
             each         -> one container per example/agents/<dir> (per-agent comparison; a new
                             agent added in a PR is picked up automatically)
             agent:<name> -> just that agent + a venue-arb reference
  MODE = frozen (coded, no LLM) | llm (improve loop -> Ollama gpt-oss:20b)
Container name is eris-<id> and id == the agent dir, so the sampler/agg break down per agent.
"""
import re, sys, os

BLOCKS, BT, MODE, OUT, ROSTER = sys.argv[1:6]
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(REPO)
if MODE not in ("frozen", "llm"):
    sys.exit("bad MODE " + MODE)

src = open("config/local.yaml").read()
head = src[:src.index("\nagents:")]
head = re.sub(r"^(\s*)blocks:\s*\d+", rf"\g<1>blocks: {BLOCKS}", head, flags=re.M)
secs = int(int(BLOCKS) * int(BT) * 1.5) + 300
head = re.sub(r"^(\s*)seconds:\s*\d+", rf"\g<1>seconds: {secs}", head, flags=re.M)
head = re.sub(r"^(\s*)blockTimeSec:\s*\d+", rf"\g<1>blockTimeSec: {BT}", head, flags=re.M)
head = head.replace("protocols: [uniswap, balancer, curve, lst, liquity]",
                    "protocols: [uniswap, balancer, curve, gmx, aave]")
m = re.search(r"\nstress:.*?(?=\n[a-z]|\Z)", head, flags=re.S)
crash = ("\nstress:\n  events:\n    - { type: crash, magnitudeRange: [0.12, 0.16], "
         "windowFrac: [0.3, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }")
head = head[:m.start()] + crash + head[m.end():] if m else head + crash

wrapper = os.path.join(REPO, "infra/docker-agent/run-agent.sh")
def env_for(dirname):
    d = os.path.join(REPO, "example/agents", dirname)
    extra = ', ERIS_AGENT_FROZEN: "1"' if MODE == "frozen" else ', ERIS_LLM_MODEL: "gpt-oss:20b"'
    return '{ ERIS_AGENT_DIR: "' + d + '"' + extra + ' }'
def entry(agent_id, dirname):
    return (f"  - id: {agent_id}\n    dir: {dirname}\n    wallet: AUTO\n"
            f"    command: {wrapper}\n    env: {env_for(dirname)}\n")

# roster
roster = []   # (id, dir)
if ROSTER == "each":
    skip = {"runtime", "lib", "noop"}
    for d in sorted(os.listdir("example/agents")):
        if d in skip or not os.path.isdir(os.path.join("example/agents", d)):
            continue
        roster.append((d, d))                       # id == dir -> container eris-<agent>
elif ROSTER.startswith("agent:"):
    name = ROSTER.split(":", 1)[1]
    if not os.path.isdir(os.path.join("example/agents", name)):
        sys.exit("no such agent: example/agents/" + name)
    roster = [(name, name), ("venue-arb-ref", "venue-arb")]
else:
    n = int(ROSTER)
    roster = [("arb-%03d" % k, "venue-arb") for k in range(2, n + 1)]

ag = "\nagents:\n  - id: noop\n    wallet: AGENT1_PRIVATE_KEY\n    baseline: true\n"
ag += "".join(entry(i, d) for i, d in roster)
open(OUT, "w").write(head + ag)

chk = open(OUT).read()
assert "gmx, aave" in chk and ("blockTimeSec: " + BT) in chk and chk.count("command: ") == len(roster)
print("%s: %d containers (%s), blocks=%s bt=%s mode=%s" %
      (OUT, len(roster), ROSTER, BLOCKS, BT, MODE))
