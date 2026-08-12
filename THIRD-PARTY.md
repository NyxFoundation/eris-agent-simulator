# Third-party code

The repository is MIT (see [LICENSE](LICENSE)). That covers everything written here. Three things in
the tree are somebody else's work and keep their own terms, and this file records which — so that
"the repository is MIT" is a statement about the code we wrote rather than about every byte in it.

## Redistributed here

**`deployer/contracts/WETH9.sol` — GPL-3.0.** The canonical WETH9, kept verbatim (its own
`SPDX-License-Identifier: GPL-3.0` header is intact) so that the local chain's wrapped ether behaves
byte-for-byte like the deployed one every venue integrates against. It is a development mock, never
part of a distributed agent bundle.

**`deployer/vendor/curve/*.json` — compiled Curve contracts.** ABI and bytecode only, committed
because Curve ships prebuilt artifacts and rebuilding Vyper is not reproducible without a pinned
toolchain. Upstream, recorded in `deployer/scripts/setup-vendors.sh`:

| file | upstream |
|---|---|
| `CurveStableSwapNG*.json` | [curvefi/stableswap-ng](https://github.com/curvefi/stableswap-ng) |
| `CurveTwocrypto*.json` | [curvefi/twocrypto-ng](https://github.com/curvefi/twocrypto-ng), tag `lite-0.3.10` |

**`deployer/vendor/gmx-localhost.patch` and `deployer/vendor/aave/*`** — a patch and a build
configuration authored here against those projects' sources.

## Fetched, not redistributed

`deployer/scripts/setup-vendors.sh` clones the following at pinned commits when the deployer is first
set up. None of it is in this repository (`deployer/.gitignore`), and each carries its own licence:

| clone | project |
|---|---|
| `vendor/liquity-src/` | Liquity V1 (all 81 contract sources are `SPDX-License-Identifier: MIT`) |
| `vendor/gmx-src/` | GMX V2 (gmx-synthetics) |
| `vendor/curve-src/`, `vendor/twocrypto-src/` | Curve, for rebuilding the artifacts above |

npm dependencies are likewise resolved at install time and are not redistributed here.

## Agent bundles

`npm run bundle:agent <id>` packages the runtime, the SDK, `example/agents/lib/` and one agent
directory. Everything it contains is this repository's own code, under MIT — a participant may copy,
modify and keep whatever they build from it.
