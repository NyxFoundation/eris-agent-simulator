import test from "node:test";
import assert from "node:assert/strict";
import { classifyOrderingKey } from "../core/src/orderingKey.js";

// What `check:ordering --live` measured on anvil 1.7.1 `--order fees --base-fee 0` (2026-09-27): the
// overbid (tip 1 gwei, maxFeePerGas 3 gwei, paid 1 gwei) led the honest bid (2/2, paid 2) whichever
// arrived first.
test("classifyOrderingKey: the overbid leading in both arrival orders is a maxFeePerGas sort", () => {
  assert.deepEqual(
    classifyOrderingKey([
      { arrivedFirst: "honest", ledBy: "overbid" },
      { arrivedFirst: "overbid", ledBy: "overbid" },
    ]),
    { verdict: "max-fee", consistent: ["max-fee"] },
  );
});

test("classifyOrderingKey: the honest bid leading in both arrival orders is a sort on what was paid", () => {
  assert.equal(
    classifyOrderingKey([
      { arrivedFirst: "honest", ledBy: "honest" },
      { arrivedFirst: "overbid", ledBy: "honest" },
    ]).verdict,
    "paid",
  );
});

test("classifyOrderingKey: first-come-first-served is named, not mistaken for either fee key", () => {
  assert.equal(
    classifyOrderingKey([
      { arrivedFirst: "honest", ledBy: "honest" },
      { arrivedFirst: "overbid", ledBy: "overbid" },
    ]).verdict,
    "arrival",
  );
});

test("classifyOrderingKey: one arrival order cannot separate paid from arrival, and says so", () => {
  // Sent honest-first only: both hypotheses predict the honest bid first.
  assert.deepEqual(
    classifyOrderingKey([{ arrivedFirst: "honest", ledBy: "honest" }]),
    { verdict: "ambiguous", consistent: ["paid", "arrival"] },
  );
  // But an overbid leading after arriving second is unambiguous even from one round.
  assert.equal(
    classifyOrderingKey([{ arrivedFirst: "honest", ledBy: "overbid" }]).verdict,
    "max-fee",
  );
});

test("classifyOrderingKey: contradictory pairs are mixed, and no pairs is inconclusive (not a pass)", () => {
  assert.equal(
    classifyOrderingKey([
      { arrivedFirst: "honest", ledBy: "overbid" },
      { arrivedFirst: "honest", ledBy: "honest" },
    ]).verdict,
    "mixed",
  );
  assert.equal(classifyOrderingKey([]).verdict, "inconclusive");
});
