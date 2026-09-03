# Agent-to-agent isolation (anti-abuse A)

`--network host` (the default) puts every agent in the host network namespace, so agents can see each
other and every host service (anvil, monitoring). Requirement: **block agent↔agent**, while keeping
agent→anvil and agent→internet (a team may bring its own LLM, so egress can't be fully cut and there is
no operator LLM proxy).

## Verified mechanism (no sudo, no firewall)

**Per-agent network + multi-homed anvil.** Each agent runs on its OWN docker bridge network `ag-<id>`
that only the anvil container also joins. Agents on different networks are on separate L2 segments, so
they can't reach each other; anvil is reachable by name; each network NATs to the internet.

Prototyped and confirmed (2026-09-03):

| from agent A (net ag-1) to | result |
|---|---|
| anvil (`t-anvil:8545`, multi-homed) | **REACHABLE** ✅ |
| agent B (net ag-2) | **blocked** ✅ |
| internet (1.1.1.1:443) | **REACHABLE** ✅ (own LLM ok) |

Also tested: a single ICC-disabled bridge (`ascon-agents`, created) blocks agent↔agent and allows
egress too, but agent→anvil is then blocked by the host firewall (bridge→host is dropped — the same
reason the exporter/gateway use the node-exporter textfile bridge). So it would need a firewall rule for
anvil; the **per-agent-network approach is preferred because it needs no firewall change**.

## How the code supports it

- `run-agent.sh`: `ERIS_AGENT_ISOLATE=1` → creates `ag-<ERIS_AGENT_ID>`, connects the anvil container
  (`ERIS_ANVIL_CONTAINER`, default `ascon-anvil`) to it, and runs the agent on `--network ag-<id>`.
  Egress and caps (stage-1 hardening) are unchanged. Default (unset) stays `--network host`.
- `reap.sh`: after a run, removes `ag-*` networks that have no agent container left (disconnects anvil,
  removes the network). Idempotent.

## Activation (competition env)

1. Run **anvil as a bridge container** named `ascon-anvil` (not host-net), so agents' per-agent networks
   can join it by name. Repoint the sim / eris-exporter / rpc-gateway to reach anvil by name instead of
   `127.0.0.1:8545` (they are host-net today; this is the one structural change).
2. Set `ERIS_AGENT_ISOLATE=1` and `ERIS_RPC_URL=http://ascon-anvil:8545` in the agent roster env.
3. `run-agent.sh` + `reap.sh` then create/clean the per-agent networks automatically.

Status: **isolation mechanism verified end-to-end at small scale; run-agent.sh + reap.sh implement it.**
The remaining step is running anvil as a bridge container in the competition environment (above) — a
network-topology change to do at competition-env buildout, not on the live monitoring chain.
