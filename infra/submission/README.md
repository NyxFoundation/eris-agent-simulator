# infra/submission — agent submission safety scan

`scan-submission.py` statically screens a submitted agent (ZIP or directory) BEFORE the operator accepts
it / builds the per-team image. It is defense-in-depth in front of the runtime container caps
(`infra/docker-agent` — 1GB/OOM, 0.5 CPU, pids-limit, read-only rootfs, no-new-privileges): reject the
cheap, obvious abuse at the door so it never reaches the box.

```bash
python3 infra/submission/scan-submission.py <agent.zip|dir> [--json]
# exit 0 = accept (no BLOCK), 1 = reject (>=1 BLOCK). WARN/INFO never fail — operator eyeballs them.
```

Checks: zip-bomb (compression ratio, declared size, file count, path traversal), native/binary blobs,
oversized files; source red flags in .ts/.js — child_process/exec, eval/Function/vm, raw sockets
(net/dns/tls), fs writes, chain cheatcodes (anvil_/evm_setBalance/setStorageAt), outbound HTTP/WS
(WARN — confirm it targets the allowed RPC/LLM), process.env reads (WARN); package.json install
lifecycle hooks (supply-chain) and non-registry deps; hardcoded secrets and crypto-miner signatures.

Calibration: all 24 `example/agents/*` accept (0 BLOCK); a sample agent using child_process + fetch +
fs writes + a cheatcode + a postinstall hook is rejected (4 BLOCK). Not a sandbox and not exhaustive —
the runtime container is the real boundary; this rejects the obvious stuff early.


## Operator-shipped code inside a bundle (fixed 2026-09-17)

The calibration line above — "all 24 `example/agents/*` accept" — was measured against **agent
directories**. A real submission is not one: `npm run bundle:agent` packs "the entire sdk + runtime +
lib + one agent", and scanning those bodies rejects every honest submission. Measured on a stock
`bundle:agent basis-arb` output: **20 BLOCK, and every one of them ours** —
`agents/runtime/llm.ts` spawns processes, `state.ts` writes files, `sdk/src/config.ts` reads env.
The participant's own directory had zero.

So the documented flow ("screens a submitted agent (ZIP or directory) BEFORE the operator accepts
it") rejected 100% of valid submissions, for reasons the participant could not fix.

Skipping those paths would have been worse — a participant can edit the vendored copy. Instead each
file under `sdk/`, `agents/runtime/` and `agents/lib/` is compared byte-for-byte against the repo:

| | |
|---|---|
| identical | body not scanned (it is operator code doing its job) |
| **modified** | **BLOCK** — "operator-shipped file MODIFIED" |
| **not in the repo** | **BLOCK** — something was added to the vendored runtime |

This is stricter than before, not looser. Previously a tampered `sdk/src/config.ts` looked exactly
like an untampered one: both BLOCK'd for `child_process`, and the finding said nothing about
tampering. Verified: a stock bundle accepts (0 BLOCK); the same bundle with a shell-exec appended to
`sdk/src/config.ts` rejects; adding `agents/runtime/backdoor.ts` rejects.

`ERIS_REPO` overrides the reference checkout (default: this script's repo root).
