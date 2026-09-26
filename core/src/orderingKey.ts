// Which transaction field does the block builder sort on? (`npm run check:ordering -- --live`)
//
// The rules (§2.6) order a block by the priority fee: the auction is meant to be over what each
// sender *pays*. anvil's `--order fees` sorts its pool on maxFeePerGas instead (foundry v1.7.1,
// crates/anvil/src/eth/pool/transactions.rs: `TransactionPriority(tx.max_fee_per_gas())`), and at
// base fee 0 a tx pays min(maxFeePerGas, maxPriorityFeePerGas). The two agree only while every
// sender signs maxFeePerGas <= maxPriorityFeePerGas; the probe pairs a bid that does with one that
// does not, and this module reads the outcome.
//
// Pure, so the verdict can be tested without a chain. Three hypotheses are kept and each observation
// strikes out the ones it contradicts:
//
//   max-fee  the overbid (lower tip, higher maxFeePerGas) always leads    -> anvil
//   paid     the honest bid (higher tip = maxFeePerGas) always leads       -> op-geth's effective tip
//   arrival  whichever arrived first leads                                  -> no auction at all
//
// A probe that only ever sends the pair in one arrival order cannot separate "paid" from "arrival"
// (both predict the honest bid first when it is sent first), so the caller alternates arrival order
// across rounds and the verdict says "ambiguous" rather than guessing when it could not tell.

export type KeyProbePair = {
  arrivedFirst: "honest" | "overbid";
  ledBy: "honest" | "overbid";
};

export type OrderingKey = "max-fee" | "paid" | "arrival";

export type OrderingKeyVerdict =
  | { verdict: OrderingKey; consistent: OrderingKey[] }
  | { verdict: "ambiguous"; consistent: OrderingKey[] }
  | { verdict: "mixed"; consistent: [] }
  | { verdict: "inconclusive"; consistent: [] };

export function classifyOrderingKey(
  pairs: readonly KeyProbePair[],
): OrderingKeyVerdict {
  if (pairs.length === 0) return { verdict: "inconclusive", consistent: [] };
  const holds: Record<OrderingKey, boolean> = {
    "max-fee": true,
    paid: true,
    arrival: true,
  };
  for (const p of pairs) {
    if (p.ledBy !== "overbid") holds["max-fee"] = false;
    if (p.ledBy !== "honest") holds.paid = false;
    if (p.ledBy !== p.arrivedFirst) holds.arrival = false;
  }
  const consistent = (Object.keys(holds) as OrderingKey[]).filter(
    (k) => holds[k],
  );
  if (consistent.length === 0) return { verdict: "mixed", consistent: [] };
  if (consistent.length === 1) return { verdict: consistent[0], consistent };
  return { verdict: "ambiguous", consistent };
}
