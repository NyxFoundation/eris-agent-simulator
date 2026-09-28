# infra/inference-proxy — the one door between agents and models

Rules §2.3: an agent's process cannot connect to external networks; §2.5's inference is performed by
the operator's orchestrator on the agent's behalf. This proxy is that orchestrator, kept as thin as
the requirement allows (memory: *inference-proxy-design*): allowed paths only, models from the
published list, keys attached here, every exchange recorded.

```
agent container ──(internal docker network)──▶ inference-proxy :8790 ──▶ provider
                                            └▶ rpc-gateway :8546     ──▶ anvil
```

## Run

```bash
cp infra/inference-proxy/models.example.yaml infra/inference-proxy/models.yaml   # edit the list
export ERIS_INFERENCE_SECRET="$(openssl rand -hex 32)"      # shared with the coordinator
export OPENAI_API_KEY=... ANTHROPIC_API_KEY=... OLLAMA_API_KEY=...
npm run inference-proxy -- --models infra/inference-proxy/models.yaml --listen 0.0.0.0:8790 \
    --record runs/<competition>/inference
```

Start the coordinator with the same `ERIS_INFERENCE_SECRET` and `ERIS_INFERENCE_BASE_URL=http://<proxy>:8790`.
It hands every agent `ERIS_INFERENCE_TOKEN` (an HMAC of the agent id under the secret) and the base URL,
and never the secret or an upstream key (`core/src/realtime/agentProcess.ts`). The runtime's `llm.ts`
routes the Ollama, OpenAI-compatible and Anthropic providers through the base URL when it is set.

## What it enforces

| check | response |
|---|---|
| path other than `/api/chat`, `/v1/chat/completions`, `/v1/messages` (`GET /v1/models`, `/healthz` read-only) | 404 |
| missing or wrong `x-eris-agent` + bearer token (when a secret is set) | 401 |
| `model` not in the list, or on the wrong provider's path | 403 with the allowed names |
| a stored/previous reference: OpenAI `previous_response_id` `prompt` `store` `metadata` `file_ids` `attachments` `tools` `tool_resources`; Anthropic `container` `mcp_servers` `tools` | 403 naming the key |
| more than `maxCallsPerMinute` per agent | 429 |

## Waiting, and streaming (issue #166)

Streaming is relayed, not refused. A response the provider streams — SSE on `/v1/chat/completions` and
`/v1/messages` with `"stream": true`, NDJSON on `/api/chat` (Ollama streams unless the body says
`"stream": false`) — reaches the agent chunk by chunk under the provider's status and `content-type`.

| call | how long the proxy waits | set by |
|---|---|---|
| not streamed | the whole answer: `upstreamTimeoutMs`, default 300000 (5 min). Higher values do not help: Node's fetch gives up after 300 s without response headers, and a non-streamed answer's headers arrive only once it is complete | operator (`models.yaml`) |
| streamed | silence only: `streamIdleTimeoutMs` without a byte, before the first or between any two chunks (default: `upstreamTimeoutMs`). No total — the epoch is one: when it ends the agent is stopped and its connection closes. Size: cut past `maxStreamBytes` (default 32 MiB), so one call's record stays finite | operator (`models.yaml`) |

A slow reader is not buffered for: when the agent's connection stops draining, the proxy stops pulling
from the provider until it does, and an agent that reads nothing for `streamIdleTimeoutMs` is treated
like a provider that sends nothing.

**An agent that stops waiting stops the generation.** When the agent's connection closes before the
answer is complete — its own timeout, or the epoch ending — the proxy aborts the upstream request,
streamed or not. The participant pays for the tokens (rules §2.5). The record says so
(`"error": "client disconnected"`; status 499 when no answer had started).

The operator caps neither input nor output tokens: the body is forwarded as written, so the limits are
the model's and the service's, plus whatever the agent's client asks for.

## Recording and replay (rules §2.4)

One JSON line per call under `<record>/<agentId>.jsonl`: `seq` (per agent, retries included), path,
model, the request body as the agent sent it, the upstream status, `contentType` and response,
duration. Replaying an evaluation is `--replay <that dir>`: the proxy serves the recorded responses
back in order and never calls a provider, so a non-deterministic model gives a deterministic re-run.
A run that asks for more calls than were recorded gets 409 at the first missing one, which is a
difference worth knowing about rather than a silent divergence.

A streamed call is still **one** record, written when the stream ends: `"stream": true` and the whole
stream as text in `response` (the SSE events or NDJSON lines as sent). Replay serves it back under the
recorded content type. A stream that broke off — it went quiet, or the agent left — is recorded with
what had arrived and an `error`, and replays the same way: that text, then the connection is cut.

## Network

Each agent runs on its own docker network with the RPC gateway as the hub (`ERIS_AGENT_ISOLATE=1`,
`infra/docker-agent/ISOLATION.md`). `ERIS_AGENT_INTERNAL=1` creates that network `--internal` — no route
out — and `ERIS_INFERENCE_HUB=<proxy container>` attaches this proxy to it, so the agent can reach
exactly two things: the gateway and the proxy. That is what makes "no direct external connection"
true rather than promised:

```bash
docker run -d --name ascon-inference-proxy ... npm run inference-proxy -- --models ... --listen 0.0.0.0:8790
ERIS_AGENT_ISOLATE=1 ERIS_AGENT_INTERNAL=1 ERIS_INFERENCE_HUB=ascon-inference-proxy \
ERIS_INFERENCE_BASE_URL=http://ascon-inference-proxy:8790 ERIS_RPC_URL=http://ascon-rpc-gateway-live:8546 ...
```
