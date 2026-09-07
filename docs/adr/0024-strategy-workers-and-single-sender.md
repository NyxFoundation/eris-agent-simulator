# ADR 0024: Bounded strategy workers and one runtime sender

Date: 2026-09-07. Status: accepted for the reference runtime.
Issues: [#85](https://github.com/NyxFoundation/eris-agent-simulator/issues/85),
[#86](https://github.com/NyxFoundation/eris-agent-simulator/issues/86),
[#87](https://github.com/NyxFoundation/eris-agent-simulator/issues/87).

## Decision

Remove `walletClient` from `AgentContext` (issue #85 option 1). Strategies return actions or use
`ctx.submit`, including `rawTx` for calldata and deployment. `publicClient` remains available for
reads; its transport rejects sends/signing and privileged namespaces, including when called through
`request()`. A general wallet proxy would need to reconcile caller-signed nonces, account overrides,
and wallet return values with an asynchronous, validating action API. Removing the unused capability
keeps that contract explicit.

Usage inventory at the parent commit: no strategy in `example/agents/` uses `ctx.walletClient`.
`liquidator` and the other `run(ctx)` agents already use `ctx.submit`. The remaining wallet clients in
`runtime/bot.ts`, `runtime/send.ts`, and the standalone `runtime/deploy.ts` helper are internal or
explicit helper arguments, not `AgentContext` accesses. The Japanese/English starter guide and
Japanese/English agent-contract specification advertised the removed field and are updated.
External strategies using it must encode calldata and submit a `rawTx` action instead.

Run shipped and generated `decide` implementations in one reusable Worker per agent. The parent
sends observations by structured clone and owns the 5,000 ms deadline. It terminates a stuck worker,
discards that call's returned action and buffered `ctx.submit` actions, and reloads the selected
source for the next decision. Logs stream to the parent's existing appender during an active call.
A completed call cannot submit or log later using a retained context.

The parent owns the reader, sender, nonce, logs, improvement loop, evidence and version history.
Revisions are source descriptors (module path or generated body), not functions transferred across
threads. Selecting a new version applies to the next decision; an already running decision completes
under its original version or times out. Generated bodies are revalidated in the worker; their
source remains in parent-owned version history and the existing optional state store. Timeout never
selects an earlier version. Worker replacement resets module variables; use the existing state
mechanism for data that must survive disposal or epoch boundaries.

The TypeScript bootstrap explicitly registers `tsx/esm/api` from a `.mjs` entry, supporting Node 22
and submission bundles without relying on native TypeScript support or the repository's tsconfig.
Module initialization is also bounded at 5 seconds. `run(ctx)` keeps its self-driven lifecycle,
immediate submission, and observation subscriptions; `onObservation()` is a run-only API.
For a worker decision, `latestObservation()` is the snapshot passed to that call.

### Rules §2.3 commentary

The agent process remains alive while a timed-out computation is discarded. Replacing a worker is
therefore not restarting a terminated agent, freezing its strategy, or rolling it back. A dead
agent process is still not revived for the remainder of the epoch. This distinction implements the
existing “no action for that block” timeout outcome for synchronous loops as well as unresolved awaits.

### Sender failures

The sender allocates a nonce after local gas checks and accounts gas only after RPC acceptance.
Local rejection consumes no nonce. Any submission failure, including a transport failure with an
unknown acceptance outcome, invalidates the nonce cache so the next send resynchronizes from
`pending`. This also avoids gaps when a failed strategy proposal is followed by a valid one.

### RPC boundary

The participant gateway refuses pending transaction enumeration and pending block reads, while
preserving pending nonce queries. The measured pre-fix leak, exact method policy, and regression
commands are recorded in [the gateway README](../../infra/rpc-gateway/README.md#pending-transaction-visibility-issue-87).
This is a gateway policy, not a new prohibition in the competition rules. Workers and the read-only
context are runtime API boundaries, not security sandboxes for arbitrary participant-authored Node
programs; direct upstream access remains an operator deployment concern.

## Measurement

Local measurement on 2026-09-07, macOS arm64, Node v22.14.0. Run
`node --import tsx scripts/benchStrategyWorker.ts`. A synthetic 60,887-byte observation (512 records),
a small reduction strategy, 50 warmup calls and 1,000 measured calls; five timeout/respawn samples.

| Operation | Median | p95 |
|---|---:|---:|
| Existing in-process call | 0.0016 ms | 0.0041 ms |
| `structuredClone(obs)` alone | 0.324 ms | 0.427 ms |
| Worker decision round trip, including clone | 0.352 ms | 0.372 ms |
| Reload after termination, through first successful decision | 499 ms | 592 ms |

Initial worker startup took 1,008 ms. Parent-process RSS went from 144 to 229 MiB (about +85 MiB);
the worker's JS heap used 26 MiB. RSS includes V8/loader/native allocations and is allocator-sensitive.
The normal-call delta was about 0.35 ms; respawn is much slower than the issue's initial ~50 ms
estimate and is paid only after disposal or a source change. These are local microbenchmarks, not
claims about production RPC latency or a 2-vCPU container.

## Validation

Regression tests cover synchronous loops, unresolved awaits, installed looping revisions, subsequent
revisions, stale callbacks, module state, bigint cloning, worker crashes, invalid clone results,
explicit shutdown, pending nonce seeding, submission logging and gateway filtering on a real Anvil.
A module that always loops will time out again on the next block, but the parent improvement loop
remains able to install a working revision. There is no automatic rollback.
