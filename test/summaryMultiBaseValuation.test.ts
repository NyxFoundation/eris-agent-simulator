// summary.json's netPnlUsdc must price every base, not just WETH.
//
// valueUsdc marks an unlisted base at `p[sym] ?? 0`, so handing it the scalar WETH price silently
// values an agent's WBTC at zero: whoever ends the run holding a non-WETH base has that inventory
// deleted from their PnL. Found in the ADR 0017 §5 pilot -- on a 24-agent calm run the WBTC-trading
// agents reported a reproducible -6,686 USDC loss (to the cent, across four independent addresses
// and two repeats) while the scoring reconstruction, which prices every base since issue #41, put
// the same agents at +13 alpha.
//
// This is the same class of bug as issue #41, on the other scoring path: #41 fixed reconstruct.ts
// and left the coordinator's end-of-run summary untouched. It matters more now that ADR 0017 ranks
// the competition on netPnlUsdc.
//
// The multi-base assertions need a registry that actually has a second base, which only the local
// deploy constants provide (the fork default is WETH-only), so they skip elsewhere. The invariant
// they protect is enforced at the call site in coordinator.ts, which passes ctx.fairPrices.
import test from "node:test";
import assert from "node:assert/strict";
import { valueUsdc } from "@eris/sdk/pnl.js";
import { baseTokens } from "@eris/sdk/markets.js";
import type { BalanceSnapshot } from "@eris/sdk/types.js";

// A registered base that is not WETH, if the active registry has one.
const extraBase = baseTokens().find((t) => t.symbol !== "WETH");

test("the per-base map values every base the agent holds", (t) => {
  if (!extraBase) {
    t.skip(
      "registry has no non-WETH base (fork default); needs local constants",
    );
    return;
  }
  const unit = 10n ** BigInt(extraBase.decimals);
  const held: BalanceSnapshot = {
    ethWei: 0n,
    wethWei: 10n ** 18n,
    usdcUnits: 1_000_000_000n, // 1,000 USDC
    bases: { WETH: 10n ** 18n, [extraBase.symbol]: unit },
  };
  const prices = { WETH: 2000, [extraBase.symbol]: 60_000 };
  assert.equal(valueUsdc(held, prices), 1000 + 2000 + 60_000);
  // The scalar form is the bug: the same holding loses the entire extra base.
  assert.equal(valueUsdc(held, 2000), 1000 + 2000);
});

test("a round trip into a non-WETH base is not a loss", (t) => {
  if (!extraBase) {
    t.skip(
      "registry has no non-WETH base (fork default); needs local constants",
    );
    return;
  }
  // The shape of the pilot failure: start in USDC, end holding the base bought at fair. Priced
  // correctly that is flat; priced with the scalar it looks like the position was burned.
  const unit = 10n ** BigInt(extraBase.decimals);
  const prices = { WETH: 2000, [extraBase.symbol]: 60_000 };
  const before: BalanceSnapshot = {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 60_000_000_000n, // 60,000 USDC
    bases: { WETH: 0n },
  };
  const after: BalanceSnapshot = {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 0n,
    bases: { WETH: 0n, [extraBase.symbol]: unit },
  };
  assert.equal(valueUsdc(after, prices) - valueUsdc(before, prices), 0);
  assert.equal(valueUsdc(after, 2000) - valueUsdc(before, 2000), -60_000);
});

test("a WETH-only holding is valued the same either way", () => {
  // The scalar form stays correct for the WETH-only case, which is why the bug went unnoticed:
  // every regime before multi-asset ended with agents holding only WETH and USDC.
  const held: BalanceSnapshot = {
    ethWei: 0n,
    wethWei: 3n * 10n ** 18n,
    usdcUnits: 1_000_000_000n,
    bases: { WETH: 3n * 10n ** 18n },
  };
  assert.equal(valueUsdc(held, 2000), valueUsdc(held, { WETH: 2000 }));
  assert.equal(valueUsdc(held, 2000), 1000 + 6000);
});
