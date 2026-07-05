[← README](../../README.md)

# Configuration (config/local.yaml)

The settings for a realtime run (`sim:realtime`) are managed in a single YAML (`config/local.yaml`) instead of being scattered across env vars. Run knobs (the nested `run` / `funding` / `limits` / `flow` / `stress` / `vuln` sections) and the agent roster (`agents`) can all be written in one file. The resolution order is `--config <path>` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml` (the committed template = zero-config default).

```bash
cp config/example.yaml config/local.yaml
npm run sim:realtime                                   # reads config/local.yaml by default
npm run sim:realtime -- --config config/vuln-test.yaml    # specify a different file
```

- Keys are **nested lowercase** (`run.protocols` / `funding.wethWei` / `flow.uninformedMaxWethWei` etc.). Values are typed (boolean, number, array, object). Unspecified keys take their defaults. Unknown keys warn.
- **Do not write secrets into the YAML.** Put RPC URLs, private keys, and API keys in `.env.local` (`ARB_RPC_URL` / `*_PRIVATE_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY`). `config/local.yaml` is gitignored; `config/example.yaml` is the committed template.
- One-shot overrides go via CLI flags (`--seed` / `--blocks` / `--protocols` etc.). Each agent's `env` is a strategy parameter passed to the agent process and is written under `agents[].env`.

Committed templates in `config/`: `example.yaml` (minimal roster) / `vuln-test.yaml` (vulnerability events) / `regimes/` (official regimes = market scenarios for [Backtest](backtest.md); this YAML follows the same schema).

## Main sections

| section | role | example |
|---|---|---|
| `run` | run knobs (SEED, block count, realtime cap, enabled venues, mode) | `protocols: [uniswap, balancer, curve]` |
| `funding` | initial distribution (a USDC-only distribution can eliminate initial directional exposure) | `wethWei: "0"` |
| `limits` | per-round caps for agents | `agentWethWei: "1000000000000000000"` |
| `flow` | orderflow bot intensity (how much it moves the market) | `uninformedMaxWethWei: "1000000000000000000"` |
| `stress` | market stress events (default off) | [stress-events.md](stress-events.md) |
| `vuln` | vulnerability-injection events (default off) | `config/vuln-test.yaml` |
| `agents` | agent roster (written inline) | see below |

## Roster (convention-based resolution, ADR 0015)

A roster `id` points at the `example/agents/<id>/` directory, and spawning is always handled by `runtime/bot.ts`. The basic form is the 2 lines `{ id, wallet }`:

```yaml
agents:
  - id: venue-arb              # runtime/bot.ts drives example/agents/venue-arb/
    wallet: AGENT2_PRIVATE_KEY
    description: WETH-only cross-venue arbitrage
  - id: multi-arb-wide         # multiple instances of the same strategy point at the real directory via dir
    dir: multi-arb
    wallet: AUTO               # AUTO is derived from the seed (no cap on named slots)
    env: { ERIS_ARB_SAFETY_BPS: "150" }   # strategy parameter passed to the agent process
```

> Local-deploy account 0 (account0) overlaps the deployer's deployment account and distorts value with leftover balance, so the roster uses AGENT1 onward (account1+).

### Fields of agents[]

| key | required | description |
|---|---|---|
| `id` | ✓ | The agent's identifier. Points at `example/agents/<id>/` (log output goes to `runs/<run_id>/agents/<id>.jsonl`) |
| `wallet` | ✓ | `AGENT0_PRIVATE_KEY`–`AGENT6_PRIVATE_KEY` (the name of the env var carrying the private key; put it in `.env.local`; locally it falls back to an Anvil dev key even if unset) or `AUTO` (derived from the seed). A named wallet cannot be duplicated within the same roster |
| `dir` | | Override for the real directory (when lining up multiple instances of the same strategy under different ids) |
| `baseline` | | `true` treats it as a zero-skill baseline (noop / random) |
| `description` | | Human-readable description |
| `env` | | Strategy parameters passed to the agent process (`ERIS_AGENT_MODE` / `ERIS_LLM_*` etc.; distinct from the sim config keys) |
| `command` / `args` | | Override for a fully custom agent (other languages etc.; read/send/validate all self-provided = unsupported). Normally omitted |

## One-shot CLI overrides (sim:realtime)

Without editing the YAML, you can override values per run (CLI flags take highest priority; both `--key value` and `--key=value` are supported. Exceptions: `--config` accepts only the `--config <path>` form and `--local-deploy` is used as a bare flag — these two are resolved before the config is loaded, so the `=` form does not work):

| flag | config key | example |
|---|---|---|
| `--config <path>` | (config file selection) | `--config config/vuln-test.yaml` |
| `--seed` | `run.seed` | `--seed 7` |
| `--blocks` | `run.blocks` | `--blocks 40` |
| `--seconds` | `run.seconds` | `--seconds 120` |
| `--protocols` | `run.protocols` | `--protocols uniswap,balancer,curve` |
| `--agents` | `run.agentsConfig` | `--agents my-roster.yaml` (roster file. **Ignored if the config file has an inline `agents:`** = inline wins. See note below) |
| `--local-deploy` | `run.localDeploy` | `--local-deploy` |
| `--economic-gas` | `run.economicGas` | `--economic-gas` |

> **How `--agents` behaves**: `sim:realtime` resolves the roster in the order "inline `agents:` > `run.agentsConfig` / `--agents` > default," so in a config with an inline roster (like `config/local.yaml`) `--agents` has no effect (edit the YAML's `agents:` instead). `npm run backtest`'s `--agents` is a separate mechanism that bakes the roster into the effective regime YAML, so it always replaces the roster even if the regime has an inline one ([Backtest](backtest.md)).

> `npm run backtest` is a separate entry point with its own dedicated flags `--regime` / `--repeat` / `--state` / `--port` etc. (overrides propagate to the agent processes too, as the "effective regime YAML"). See [Backtest](backtest.md).
