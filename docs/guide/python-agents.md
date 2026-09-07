# Python strategies

`strategy.py` is a strategy entry point for the same reference runtime as `agent.ts`.
Copy `example/agents/my-arb-py` to start. Ship exactly one of these entry points; add
`prompt.md` (`kind: improve`) for submission. A Python strategy without a policy is useful
as a local rule-only agent. The sample includes a policy and is bundleable.

## Setup and run

The team container pins CPython [3.11.16](https://www.python.org/downloads/release/python-31116/).
For local development use Python 3.11 or later:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./sdk-py
export ERIS_PYTHON="$PWD/.venv/bin/python"
cp -r example/agents/my-arb-py example/agents/my-python
```

Declare additional dependencies, with versions, in `example/agents/my-python/requirements.txt`.
Install that file in the local venv. `agent:build -- team my-python` installs it at **build time**;
the running container has a read-only root filesystem. Installing a package is not part of an LLM revision.
The container wrapper uses its own `python3`, even when `ERIS_PYTHON` points at a host venv.
Use `ERIS_DOCKER_PYTHON` only to select a different executable installed inside a team image.

Use the ordinary roster and commands; no Python-specific coordinator or simulator is involved:

```yaml
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: my-python
    wallet: AUTO
    env:
      ERIS_LLM_MODEL: "openai:your-model"
```

```sh
npm run check:strategy
npm run sim:realtime -- --config config/local.yaml
npm run backtest -- --regime calm --seed 1 --agents config/agents/my-python.yaml --agent-sandbox process
npm run agent:build -- team my-python
npm run agent:selftest -- my-python
npm run bundle:agent my-python
```

The first two run commands need the usual deployed local chain/state dump; see [backtesting](backtest.md).
Put the roster in the config used by each command. `ERIS_AGENT_FROZEN=1` runs the shipped strategy
without revisions, including when persistent state exists.

## Strategy API

```python
from eris import Observation, Context, run
from eris.actions import swap, noop
from eris.affordable import sized, can_fund

def decide(obs: Observation, ctx: Context):
    amount = sized(obs, "USDC", 1000)  # 10% of the wallet, integer units
    if amount == 0:
        return noop(reason="below the dust floor")
    ctx.log({"reason": "buying", "round": obs.round})
    return swap(token_in="USDC", amount_in=str(amount), slippage_bps=75)

if __name__ == "__main__":
    run(decide)
```

The SDK supports synchronous and async `decide`. Models and constructor arguments use
**snake_case** (`obs.balances.usdc_units`, `raw_tx`, `max_priority_fee_per_gas_wei`). On the wire,
the original camelCase keys remain unchanged. You may also return an ordinary action dict using
wire keys, or `None`. `eris.actions` exports a constructor for every action; `Action` is the
generated union. `bundle(actions=[swap(...)])` accepts typed actions. `raw_tx(tx={"data": "0x…"})`
can deploy a contract, just as the TypeScript action can. Declare its artifact in `artifacts.json`
when automatic source scanning cannot identify it.

Amounts are decimal strings in observations and actions. Convert with `int(...)`, calculate with
Python integers, and return `str(...)`; floats lose precision for token units. `eris.affordable`
exports `balance_of`, `minimum_for`, `affordable`, `sized`, `can_fund`. `eris.markets.market_views`
normalizes base markets and executable venue quotes, with the same legacy fee fallback as the
TypeScript helper. Dust floors are the shared helper's policy, not competition order limits.

`ctx` exposes `agent_id`, `address`, `log(entry)` and `submit(action)`. It has no viem client or
wallet. For extra public reads a team can install a Python RPC library and use `ERIS_RPC_URL`.
The reference send path is always returning an action or calling `ctx.submit`; the host performs
parse/validation, nonce allocation, signing, preflight and transaction logging. Invalid wire actions
therefore produce the same `bad_action`/`rejected` records as TypeScript. SDK constructors may also
reject invalid fields earlier with a Python validation exception.

## Resident process and protocol

The host runs `python3 -u strategy.py` (or `ERIS_PYTHON`) once and communicates over JSONL.
The SDK loop retains module state between successful decisions. Every request is:

```json
{"id":1,"obs":{},"agentId":"my-python","address":"0x…"}
```

The real `obs` contains the complete observation. Before replying, a strategy may emit
`{"id":1,"log":{"reason":"…"}}` or `{"id":1,"submit":{...action...}}`. Finish with
`{"id":1,"action":{...action...}}` or `{"id":1,"action":null}`. The SDK attaches IDs and expires
each context after the call, so late callbacks cannot trade against a later block. Hand-written
bridges may use bare action/null answers and unwrapped log/submit frames, but then must ensure
exactly one response and no late output themselves. stdout is reserved for JSONL; the SDK redirects
ordinary strategy prints to stderr. The host retains a bounded stderr tail for crash diagnostics.

Each decision has the same **5-second wall-clock limit**, including Python startup after a restart.
Submit frames are buffered until a timely successful answer. On timeout/error they are discarded;
the host kills and reaps the process group, then starts the **same selected version** next block.
An installed revision or explicit revert selects a new process at the next decision; it does not
interrupt an in-flight decision. stdout is bounded to 1 MiB per buffered line/chunk and 1,000 frames
per decision. Excess output or malformed JSON is a strategy error, not a host crash.

This process boundary is an execution API, not a hostile-code security sandbox. Isolation and the
combined CPU/memory cap are enforced by the existing container. Replacing a timed-out Python
computation does not authorize restarting a dead container/agent (rules §2.3).

## Revision and persistence

Set `language: python` in policy frontmatter; the runtime also infers it from `strategy.py` and
rejects conflicting declarations. The model returns `{"notes":"why","executorPy":"<complete file>"}`,
`{"notes":"why","executorPy":null}`, or `{"notes":"why","revertTo":1}`. TypeScript's `executorTs`
is not accepted for a Python strategy. Keep imports, helper definitions, `decide` and the `run(decide)`
entry point in every replacement. The system prompt lists Python constructor vocabulary generated
from the same Action schemas as the SDK; the inference backends and model allowlist are shared.

Before installation, code passes the cheatcode scan and `python3 -m py_compile`, with a 1-second
compile limit. Compilation does not execute imports or trial-run the strategy. A rejected revision
leaves the selected version intact. Accepted full files live in the host's writable temporary
directory, so the image can remain read-only. There is no automatic rollback. Explicit revert,
revision notes, memory and epoch history use the same runtime state store. Persisted versions carry
their language, are rechecked before the first observation of a new epoch, and are never silently
interpreted as another language. Old state without a language is treated as TypeScript.

## Maintaining the generated SDK

`sdk/src/actionSchema.ts` (Zod) and `sdk/src/types.ts` (the existing Observation authority) generate
JSON Schema; pinned `datamodel-code-generator` produces committed Pydantic models. Shared bundle
leaves become schema references so typed action constructors compose. Do not hand-edit generated files.

```sh
.venv/bin/python -m pip install -r sdk-py/requirements-dev.txt
ERIS_DATAMODEL_CODEGEN="$PWD/.venv/bin/datamodel-codegen" npm run gen:python-sdk
npm run typecheck
ERIS_PYTHON="$PWD/.venv/bin/python" npm test
PYTHONPATH=sdk-py .venv/bin/python -m unittest discover -s sdk-py/tests
```

CI regenerates the models and rejects drift, checks every action in the published vocabulary, and
tests helper parity, subprocess lifetime and the shared sender. Rules Appendix A's resource/runtime
settings and §2.3's resource contract are unchanged: both language choices share the container's **4 GiB total** and inference
proxy policy. NumPy or other team dependencies consume that same combined budget; verify the actual
team image with `agent:selftest` before submission.
