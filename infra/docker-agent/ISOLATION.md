# Agent-to-agent isolation (anti-abuse A)

`--network host` (the default) puts every agent in the host network namespace, so agents can see each
other and every host service (anvil, monitoring). Requirement: **block agent↔agent**, while keeping
agent→chain. Egress: **closed** in the competition (rules §2.3, decided 2026-09-06) — `ERIS_AGENT_INTERNAL=1`
creates the per-agent network `--internal` and the operator's inference proxy joins it as a second hub
(`ERIS_INFERENCE_HUB`; `core/src/inference/proxy.ts`). The NAT-egress variant below (2026-09-04, own LLM)
stays as the verified fallback when `ERIS_AGENT_INTERNAL` is unset.

## Verified mechanism (no sudo, no firewall)

**Per-agent network + multi-homed anvil.** Each agent runs on its OWN docker bridge network `ag-<id>`
that only the anvil container also joins. Agents on different networks are on separate L2 segments, so
they can't reach each other; anvil is reachable by name; each network NATs to the internet.

Prototyped and confirmed (2026-09-03):

| from agent A (net ag-1) to | result |
|---|---|
| anvil (`t-anvil:8545`, multi-homed) | **REACHABLE** ✅ |
| agent B (net ag-2) | **blocked** ✅ |
| internet (1.1.1.1:443) | **REACHABLE** ✅ (only while `ERIS_AGENT_INTERNAL` is unset; the competition sets it) |

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

## 4.22/A production topology — the gateway as the sole RPC boundary (verified)

Combining agent isolation (A) with the cheatcode filter (4.22): each agent's private network joins ONLY
the **rpc-gateway** (the hub), not anvil. So an agent can reach nothing but the gateway, which enforces
the method allowlist (cheatcode-free) + per-client rate limit and forwards to anvil.

Verified on throwaway resources (2026-09-04), agent on its own net:

| from agent | result |
|---|---|
| gateway `eth_blockNumber` | reachable (→ anvil) ✅ |
| gateway `anvil_setBalance` | **403 blocked** ✅ |
| anvil directly | **blocked** (anvil not on the agent net) ✅ |
| another agent | **blocked** (separate net) ✅ |

`run-agent.sh ERIS_AGENT_ISOLATE=1` connects the hub (`ERIS_AGENT_HUB`, default `ascon-rpc-gateway-live`)
to each `ag-<id>` net; set `ERIS_RPC_URL=http://ascon-rpc-gateway-live:8546`. `reap.sh` cleans the nets.

### Cutover runbook (do on a STABLE/wired link — recreates anvil + gateway)

1. In `infra/monitoring/docker-compose.yml`, move **anvil** off `network_mode: host` onto a bridge
   `ascon-chain` and publish `127.0.0.1:8545:8545` (so host-net sim/eris-exporter keep reaching it at
   127.0.0.1:8545). Move **rpc-gateway-live** onto `ascon-chain`, publish `127.0.0.1:8546:8546` (tunnel
   origin), and set `UPSTREAM=http://ascon-anvil:8545`.
2. `docker compose up -d anvil rpc-gateway-live` (chain resets to the venues snapshot; monitoring blips).
3. Run agents with `ERIS_AGENT_ISOLATE=1` + `ERIS_RPC_URL=http://ascon-rpc-gateway-live:8546`.
4. Verify: agent→gateway `eth_blockNumber` ok, agent→gateway `anvil_setBalance` 403, agent→`ascon-anvil:8545`
   blocked, agent→sibling blocked; external `ascon-rpc` unchanged.

Not applied to the live stack yet: the topology is proven and the code is ready; the cutover recreates
the running anvil+gateway, so run it over wired ethernet (WiFi drops mid-cutover risk breaking the stack).

## Four things the live topology needs that nothing sets for you (measured 2026-09-17)

Trying to reproduce the live topology on the replacement box took six runs. Every failed attempt
still printed `判定: PASS` from the block-budget check, because the agents were not trading at all
and an empty run is trivially fast. The tell was always `mined tx / round`: ~12.8 when the
environment's own oracle and flow traffic is all there is, ~193 when 100 bench-max agents are really
spending their three-tx allowance.

| # | needed | what happens without it |
|---|---|---|
| 1 | `default-address-pools` widened in `/etc/docker/daemon.json` | **the 28th agent onward cannot start.** Docker's default pools yield ~27 networks and `ERIS_AGENT_ISOLATE=1` takes one per agent. `run-agent.sh` swallows the create error (`2>&1 \|\| true`), so what surfaces is `docker run ... network ag-<id> not found` |
| 2 | `run.agentSandbox: docker` **in the config** | agents run as plain host processes: no CPU/memory caps, no egress control, rules §2.3 unenforced, and `ERIS_AGENT_ISOLATE` has nothing to act on. `config/example.yaml` and `config/practice.yaml` do not set it (every `config/regimes/*.yaml` does), and `ERIS_AGENT_SANDBOX` is one of the retired env knobs the loader ignores |
| 3 | the agent's `ERIS_RPC_URL` pointing at the hub | inside a per-agent network `127.0.0.1` is the container. The bot refuses to run chainless and exits 1 — deliberately, because a silent 0-tx run looks identical to an agent that sat still |
| 4 | a chain at the venues snapshot | `flashArb: true` deploys at a deterministic address, so a chain that has already been used fails setup with `FlashArb address mismatch`. **A live run cannot be started on a chain that has been running** — which also constrains the "move to the cloud under load" escape hatch in 競技規約 §2.6.1 |

A config key in the wrong block is silent too: appending `agentSandbox: docker` after the stress
section made it `stress.agentSandbox`, and the only evidence was one `unknown config keys (ignored)`
line inside each agent's stderr.

`/etc/docker/daemon.json` on ascon-live:

```json
{ "default-address-pools": [ { "base": "10.200.0.0/12", "size": 24 } ] }
```

4096 networks instead of 27. `docker network create` was verified past 130 after the change.
