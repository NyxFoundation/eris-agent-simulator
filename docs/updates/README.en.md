# Environment updates

The [starter guide](../competition-start.en.md) always describes the current environment. This
directory holds the updates, one file per entry, so that somebody who has already read the guide can
follow the diff instead of re-reading it. Newest first.

The rules themselves are at [ascon.dev/rules](https://ascon.dev/rules), the only source. Where these
pages and the rules disagree, the rules win.

The dashboard's "Updates" page carries the same entries.

| Date | What changed |
|---|---|
| [2026-10-06](2026-10-06.en.md) | The permissionless lending contract (SimpleLending) is no longer deployed in the official regimes; only strategies using the `lending` actions in local backtests are affected |
| [2026-10-05](2026-10-05.en.md) | The practice environment was rebuilt: standings reset, every venue address changed, four changes that stop code from working, GMX fees and liquidation, and Aave's free collateral |

The Japanese files are authoritative; these are reference translations.

To add an entry, write `docs/updates/<YYYY-MM-DD>.md` and `<YYYY-MM-DD>.en.md`, and add a row above.
The dashboard reads the directory, so no page change is needed.
