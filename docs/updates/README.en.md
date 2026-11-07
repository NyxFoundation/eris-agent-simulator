# Environment updates

The [starter guide](../competition-start.en.md) always describes the current environment. This
directory holds the updates, one file per entry, so that somebody who has already read the guide can
follow the diff instead of re-reading it. Newest first.

The rules themselves are at [ascon.dev/rules](https://ascon.dev/rules), the only source. Where these
pages and the rules disagree, the rules win.

The dashboard's "Updates" page carries the same entries.

| Date | What changed |
|---|---|
| [2026-10-31](2026-10-31.en.md) | Price gaps take 1 – 2 blocks (practice environment: from around Nov 3); the GMX keeper refuses orders over the cap and does not refund them (`gmxCancelOrder` added); Uniswap V3 LP sent to you by others is not valued; generated strategies run in a child process with no key; on your own machine, pass the key in a file (`ERIS_AGENT_PRIVATE_KEY_FILE`); gateway and inference proxy limits |
| [2026-10-29](2026-10-29.en.md) | The reference price no longer returns to its starting level and gaps no longer recover; CEX drift is larger moves with no direction (live competition: rules §3.2 as amended; practice environment: in steps from Oct 28 to around Nov 2). The reference runtime leaves the environment's calls out of `obs.competition` (rebuild the ZIP to pick it up) |
| [2026-10-28](2026-10-28.en.md) | The schedule has moved (submission deadline Nov 30, live competition Dec 1 – 7, results Dec 22); the commitment to the hidden set's generation key; the practice environment extended to Nov 30; the dashboard's Register button fixed |
| [2026-10-18](2026-10-18.en.md) | The hidden set's commitment is published; Anthropic and OpenAI added as inference services (from November 1); submitted ZIPs need no rebuild; what is fixed on October 31 |
| [2026-10-08](2026-10-08.en.md) | The priority fee cap (5 gwei) is removed; the reference price is written directly into the contracts |
| [2026-10-06](2026-10-06.en.md) | The permissionless lending contract (SimpleLending) is no longer deployed in the official regimes; only strategies using the `lending` actions in local backtests are affected |
| [2026-10-05](2026-10-05.en.md) | The practice environment was rebuilt: standings reset, every venue address changed, four changes that stop code from working, GMX fees and liquidation, and Aave's free collateral |

The Japanese files are authoritative; these are reference translations.

To add an entry, write `docs/updates/<YYYY-MM-DD>.md` and `<YYYY-MM-DD>.en.md`, and add a row above.
The dashboard reads the directory, so no page change is needed.
