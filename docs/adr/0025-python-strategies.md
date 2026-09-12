# ADR 0025: Python strategies in the reference runtime

Status: accepted. Issue #88; follows ADR 0024.

Python is a submission entry point (`strategy.py` plus an improvement policy) for the existing
runtime. A resident JSONL process computes decisions. The TypeScript parent retains observation,
the single Sender, transaction validation/signing/logging, inference and epoch state. This keeps
the economic and scoring contract identical for both languages.

The parent owns and reaps the Python process group. Spawning it from a terminable Worker would
orphan it on `Worker.terminate()`. Decision IDs reject stale callbacks; submits remain buffered
until a timely response. Timeout/error discards computation and starts the selected source on
the next block. It never rolls back a version or revives a dead agent container.

Action models are generated from Zod; Observation models from the existing TypeScript declaration
through JSON Schema. A second hand-written observation schema would drift. Pinned Python codegen,
committed models, vocabulary checks and regeneration in CI make schema changes reviewable.
snake_case attributes serialize to the original wire aliases; quantities stay decimal strings.

Python revisions are complete files, checked statically and with a one-second `py_compile` before
installation. Runtime imports still happen on first execution, without a trial run. The existing
revision/version/revert state now records language; legacy state defaults to TypeScript. Resume
finishes before the first observation so asynchronous Python checking cannot race the first trade.

Team requirements install into a fixed Python base at build time. The read-only root, writable
temporary/state directories and combined 4 GiB cap apply to Node, Python and team dependencies
together. Python receives no second signing API. This is not a claim that Python processes are a
security sandbox; the existing container and network policy remain responsible for isolation.

The rules' runtime/resource terms and inference model allowlist apply equally to both formats.
The reference implementation changes no scoring, inference access, CPU/memory quota or rule text.

Validation on 2026-09-07: `my-arb` and `my-arb-py` completed the same 20-block Uniswap backtest;
the Python team image completed a 20-block `agent:selftest` through `sim:realtime`, logging 16
submitted transactions. A separate team image installed NumPy 2.3.3 from `requirements.txt` and
completed the same test; sampled combined container memory peaked at 160.2 MiB under the 4 GiB cap
(Docker Desktop arm64, Node 24, Python 3.11.16). This is a smoke measurement, not a guarantee for
arbitrary strategies or dependencies. The standalone ZIP installed and returned a typed swap.

A local mock inference service exercised the real revision loop across two 16-block epochs:
install a complete Python file, reject invalid syntax, revert to the submitted file, retain memory,
and resume versions 1 and 2 in epoch 2. No external model was called. Unit/integration tests also
cover timeout/process-group cleanup, correlated side channels, generated schema drift, helper
parity, and shared sender nonce allocation/rejection records on Anvil.
