# Eris Agent Simulator — Specification (as-built)

A normative reference for what the current implementation **is**. It is written backwards from the code, and **the code is the only source**.

日本語版: [`docs/spec/`](../README.md)

## Where this sits

| Document | Question it answers | Character |
|---|---|---|
| [README](../../../README.md) | How do I start? | Introduction |
| [docs/guide/](../../guide/) | How do I use it? | Task guides |
| [docs/adr/](../../adr/) | Why was it built this way? | Decision history (**includes decisions that were later overturned**) |
| **docs/spec/ (this)** | **What is it?** | **Normative description of the present** |
| [docs/competition-rules.md](../../competition-rules.md) | What rules do participants follow? | Competition rules (legal draft, Japanese) |

ADRs are a history, so overturned text survives in them — ADR 0002 → 0018, the continuous economy → ADR 0020. This document describes only the present, and links out to the ADR where the history matters.

## Chapters

| Chapter | Contents |
|---|---|
| [00 Overview and scope](00-overview.md) | Definition, scope, core concepts, glossary, design principles |
| [01 System architecture](01-architecture.md) | Workspace boundaries, processes, the fairness boundary, the adapter layer |
| [02 Execution model](02-runtime.md) | Run lifecycle, per-block order of work, startup validation, chainMode / resetUnit / segments |
| [03 The market](03-market.md) | Fair-price generation and propagation, orderflow, the venues |
| [04 Stress events](04-stress-events.md) | The nine event types, schedule resolution, liquidation victims |
| [05 The agent contract](05-agent-contract.md) | The three execution contracts, observations, the 25 actions, limits, self-improvement |
| [06 Scoring](06-scoring.md) | Valuation, the epoch series, M9 with G1/G2, candidate metrics, cross-scenario aggregation |
| [07 Configuration](07-configuration.md) | The full YAML schema, resolution order, CLI flags, the roster |
| [08 Artifacts](08-artifacts.md) | Every file under `runs/<id>/` and its fields, the event catalogue |
| [09 Dashboard](09-dashboard.md) | Information hierarchy, the round cursor, standings display rules |
| [10 Operations](10-operations.md) | The commands, the practice devnet, the explorer, state dumps and backtests |
| [11 Invariants and quality gates](11-invariants.md) | Startup assertions, in-run monitors, post-hoc checks, what the tests hold |
| [12 Known limits and open questions](12-open-issues.md) | What is uncalibrated, what is undecided, what is structural |

## How this is written

1. **The code is the source.** Numbers, schemas and conditions cite `file:line`. A guarantee that is not in the code is not written here.
2. **Undecided means undecided.** Questions the ADRs leave open — λ for the `scenario` mode, the number of scenarios S, what an LST is scored at — are not written as settled.
3. **Units always.** wei / units (6 decimals) / bps / USDC / blocks / seconds.
4. **Identifiers stay verbatim.** File names, type names, event names, config keys and action names appear exactly as they do in the code.

## Keeping it true

When the implementation changes, fix the affected section and its `file:line` in the same commit — including when only the line number moved. A citation nobody can follow is not a citation.
