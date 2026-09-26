// The participant fee rule: the field a block is ordered by must be the price that is paid.
//
// Rules §2.6 order a block by the priority fee, highest first. The chain is anvil `--order fees`
// with base fee 0, and anvil sorts its pool on **maxFeePerGas** (foundry v1.7.1,
// crates/anvil/src/eth/pool/transactions.rs: `TransactionPriority(tx.max_fee_per_gas())`), while a
// transaction pays min(maxFeePerGas, baseFee + maxPriorityFeePerGas) per gas. The two agree only
// when maxFeePerGas <= maxPriorityFeePerGas: then the tx pays exactly its maxFeePerGas, whatever
// the base fee, and the sort key *is* the price. Anything signed above the tip buys position
// without being paid for. Measured 2026-09-27 on anvil 1.7.1: a tx with tip 0.1 gwei and
// maxFeePerGas 7 gwei landed at txIndex 0, ahead of a 6/6 gwei tx shaped like the environment's
// oracle update, and paid 0.1 gwei/gas.
//
// So a participant's transaction must satisfy
//
//   typed (0x02 / 0x03 / 0x04):  maxFeePerGas <= maxPriorityFeePerGas <= cap
//   legacy / 0x01:               gasPrice <= cap          (gasPrice is both the key and the price)
//
// where the cap is the priority-fee cap (`fees.maxPriorityFeeWei`, 5 gwei by default) that keeps the
// oracle update, sent at cap + 1 gwei, at txIndex 0. A cap of 0 disables the cap half (the economic
// gas profile retires it, ADR 0011 §2); the maxFeePerGas half is never disabled -- it is what makes
// the auction an auction.
//
// Enforced in three places, all reading this definition: the RPC gateway refuses a breaching raw
// tx at entry (infra/rpc-gateway, its own copy -- it is dependency-free .mjs), the reference runtime
// signs only compliant fees (`participantFees`), and postRunCheck flags breaching agent rows of
// blocks.csv after the fact, which is the authority for a self-hosted participant who sends
// straight to a node.

export type TxFeeFields = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};

export type FeeRuleBreach =
  | {
      kind: "max-fee-above-tip";
      maxFeePerGasWei: bigint;
      maxPriorityFeePerGasWei: bigint;
    }
  | {
      kind: "over-cap";
      field: "maxPriorityFeePerGas" | "maxFeePerGas" | "gasPrice";
      wei: bigint;
      capWei: bigint;
    };

// The fees the reference runtime signs: both fields equal, so the order key is the price paid.
// baseFee + bid rather than bid alone so the priority actually paid is `bid` on a chain whose base
// fee is not 0 (the tx pays baseFee + bid, which is also its maxFeePerGas); on the competition's
// base-fee-0 chain it is simply `bid`. With a cap, the sum is clamped to it -- on a base-fee-0 chain
// that never binds, because the bid was already validated against the cap.
export function participantFees(
  bidWei: bigint,
  baseFeeWei: bigint,
  capWei = 0n,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  let fee = baseFeeWei + bidWei;
  if (capWei > 0n && fee > capWei) fee = capWei;
  return { maxFeePerGas: fee, maxPriorityFeePerGas: fee };
}

// The first way these fields break the rule, or null. A typed tx is recognised by carrying
// maxPriorityFeePerGas; a legacy / 0x01 tx carries gasPrice only. Fields that are absent are not
// checked (a row recorded before a column existed has nothing to judge).
export function checkFeeRule(
  fees: TxFeeFields,
  capWei: bigint,
): FeeRuleBreach | null {
  const tip = fees.maxPriorityFeePerGas;
  const maxFee = fees.maxFeePerGas;
  if (tip !== undefined) {
    if (maxFee !== undefined && maxFee > tip)
      return {
        kind: "max-fee-above-tip",
        maxFeePerGasWei: maxFee,
        maxPriorityFeePerGasWei: tip,
      };
    // maxFeePerGas <= tip from here on, so the tip bounding the cap bounds both fields.
    if (capWei > 0n && tip > capWei)
      return {
        kind: "over-cap",
        field: "maxPriorityFeePerGas",
        wei: tip,
        capWei,
      };
    return null;
  }
  const price = fees.gasPrice ?? maxFee;
  if (capWei > 0n && price !== undefined && price > capWei)
    return {
      kind: "over-cap",
      field: fees.gasPrice !== undefined ? "gasPrice" : "maxFeePerGas",
      wei: price,
      capWei,
    };
  return null;
}
