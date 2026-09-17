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


## From an accepted ZIP to a runnable image

`scan-submission.py` screens a ZIP and `infra/docker-agent/build.sh team <id>` builds from
`example/agents/<id>`, but nothing moved a ZIP into that shape — the pipeline had a gap exactly
where a competition needs an audit trail. `accept-submission.sh` closes it:

```sh
./accept-submission.sh submissions/team-alice.zip team-alice
```

Four steps, stopping at the first failure: scan → extract → `check:strategy` → build, ending with
the image digest the replay audit compares against `runs/<id>/images.jsonl`.

**Extraction takes the participant's agent directory and nothing else.** The bundle also carries
`sdk/`, `agents/runtime/` and `agents/lib/`; those belong to the operator, the scan has already
proved they are byte-identical to this repo's, and copying a participant's copy over the operator's
is how a tampered runtime would walk in the back door after passing the front one.

Verified: a stock bundle accepts and produces `eris-agent:team-demo`; a bundle with a modified
`sdk/src/config.ts` is rejected at step 1 with **no directory and no image created**; a second
submission for a team that already exists stops rather than overwriting.

## The whole path, exercised end to end (2026-09-17)

Each piece had been tested; the path had not. It was walked once with an agent the pipeline had
never seen — a fee-aware cross-venue arb written for the purpose, `team-kappa` — from a
participant's directory to a scored agent on the chain:

```sh
npm run bundle:agent team-kappa                        # participant: 88 files, ~1.0 MB
rm -rf example/agents/team-kappa                       # the operator does NOT have the source
infra/submission/accept-submission.sh bundle.zip team-kappa
```

The scan accepted with one WARN (`non-registry dependency '@eris/sdk': file:./sdk`, which is what
`bundleAgent` writes), extraction took **2 files** — the participant's own directory and nothing
else — `check:strategy` passed, and the build printed a digest.

Then the accepted **image** was run in a scenario (`spike#202`, 120 blocks, image mode — not
bindmount, because this is the submission path):

| what was checked | result |
|---|---|
| digest at acceptance | `sha256:a5134302048deb55fc5a6aed640e72bf138179ef2362ea5a2056cb152139251c` |
| digest in `runs/<id>/images.jsonl` at spawn | **the same string** |
| `mode` recorded | `image` |
| blocks the agent acted on | 102 submitted, 8 `submit_failed`, 10 `noop`, of 120 |
| baseline in the same run | 120 `noop`, as it should be |

The digest match is the point: acceptance and spawn are the two ends of the replay audit, and this
is the first run in which both ends were recorded and compared.

**A scored run is not evidence that an agent traded.** `team-kappa` scored above the baseline
(-3298.32 against -3585.58) with `T 40.0`, which says nothing about whether it ever submitted
anything — and `events.jsonl`'s `tx_submitted` carries *flow wallets only*, so counting agent
transactions there returns zero for every agent in every run. The agents' own transactions are in
`runs/<id>/agents/<id>.jsonl` as `event: "submitted"` / `"submit_failed"`. Count them there.

The eight failures were `Execution reverted with reason: Slippage.` — the agent asks for
`slippageBps: 30`, and its own `prompt.md` names that as the first thing to look at if fills are
being rejected. That is a strategy result, not a pipeline defect, and it is what a working
submission path is supposed to surface.
