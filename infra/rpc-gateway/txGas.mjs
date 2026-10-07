// Reading a signed transaction's gas limit (issue #40 T0) and fee fields without executing it.
//
// Its own module so it can be unit-tested: importing gateway.mjs starts a listening server.
// Minimal RLP: enough to read the gas and fee fields out of a signed transaction, nothing more.
function rlpDecode(buf, pos) {
  const b = buf[pos];
  if (b === undefined) return null;
  if (b <= 0x7f) return { value: buf.subarray(pos, pos + 1), next: pos + 1, list: false };
  if (b <= 0xb7) { const n = b - 0x80; return { value: buf.subarray(pos + 1, pos + 1 + n), next: pos + 1 + n, list: false }; }
  if (b <= 0xbf) {
    const lenLen = b - 0xb7;
    const n = Number(BigInt("0x" + buf.subarray(pos + 1, pos + 1 + lenLen).toString("hex") || "0"));
    return { value: buf.subarray(pos + 1 + lenLen, pos + 1 + lenLen + n), next: pos + 1 + lenLen + n, list: false };
  }
  if (b <= 0xf7) { const n = b - 0xc0; return { start: pos + 1, end: pos + 1 + n, next: pos + 1 + n, list: true }; }
  const lenLen = b - 0xf7;
  const n = Number(BigInt("0x" + buf.subarray(pos + 1, pos + 1 + lenLen).toString("hex") || "0"));
  return { start: pos + 1 + lenLen, end: pos + 1 + lenLen + n, next: pos + 1 + lenLen + n, list: true };
}

// Where each field sits in a signed transaction. Typed envelopes (EIP-2718) put a type byte before
// the RLP list, and the field order differs by type:
//   0x02 (1559): chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, ...
//   0x03 (4844): same prefix as 1559
//   0x04 (7702): same prefix as 1559
//   0x01 (2930): chainId, nonce, gasPrice, gasLimit, ...
//   legacy:      nonce, gasPrice, gasLimit, ...
// 0x04 is listed explicitly rather than folded into a range: an unrecognised envelope must NOT
// parse, because every caller treats an unreadable field as a reason to refuse, and a type that
// happens to put something else at these indices would silently report the wrong number.
function envelope(rawHex) {
  const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  const buf = Buffer.from(hex, "hex");
  if (buf.length === 0) return null;
  const type = buf[0];
  if (type === 0x01) return { type, body: buf.subarray(1), at: { gasPrice: 2, gas: 3 } };
  if (type === 0x02 || type === 0x03 || type === 0x04)
    return { type, body: buf.subarray(1), at: { maxPriorityFeePerGas: 2, maxFeePerGas: 3, gas: 4 } };
  if (type >= 0xc0) return { type: 0, body: buf, at: { gasPrice: 1, gas: 2 } };
  return null;
}

// The scalar at `index` of the envelope's RLP list, or null.
function scalarAt(body, index) {
  const outer = rlpDecode(body, 0);
  if (!outer || !outer.list) return null;
  let pos = outer.start;
  for (let i = 0; i <= index; i++) {
    const item = rlpDecode(body, pos);
    if (!item) return null;
    if (i === index) {
      if (item.list) return null;
      return BigInt("0x" + (item.value.toString("hex") || "0"));
    }
    pos = item.next;
  }
  return null;
}

// The gas limit of a signed transaction, or null when it cannot be read.
//
// Null is not "fine": the caller refuses the transaction. A cap that lets through everything it
// cannot parse is not a cap — an unrecognised envelope type would be the whole bypass, and the
// post-run check only notices after the block it starved is gone.
export function txGasLimit(rawHex) {
  try {
    const env = envelope(rawHex);
    return env ? scalarAt(env.body, env.at.gas) : null;
  } catch { return null; }
}

// The fee fields of a signed transaction, or null when they cannot be read (the caller refuses).
//   typed 0x02 / 0x03 / 0x04  -> { type, maxPriorityFeePerGas, maxFeePerGas }
//   0x01 / legacy             -> { type, gasPrice }
export function txFees(rawHex) {
  try {
    const env = envelope(rawHex);
    if (!env) return null;
    if (env.at.gasPrice !== undefined) {
      const gasPrice = scalarAt(env.body, env.at.gasPrice);
      return gasPrice === null ? null : { type: env.type, gasPrice };
    }
    const maxPriorityFeePerGas = scalarAt(env.body, env.at.maxPriorityFeePerGas);
    const maxFeePerGas = scalarAt(env.body, env.at.maxFeePerGas);
    if (maxPriorityFeePerGas === null || maxFeePerGas === null) return null;
    return { type: env.type, maxPriorityFeePerGas, maxFeePerGas };
  } catch { return null; }
}

// The participant fee rule (the same rule as sdk/src/feeRule.ts; this is a copy because the gateway
// is dependency-free .mjs that runs without a build). Returns null, or { kind, message }.
//
// anvil `--order fees` sorts the pool on maxFeePerGas (foundry v1.7.1, TransactionPriority(
// tx.max_fee_per_gas())), and at base fee 0 a transaction pays min(maxFeePerGas, maxPriorityFeePerGas).
// Measured 2026-09-27: tip 0.1 gwei with maxFeePerGas 7 gwei landed at txIndex 0 ahead of a 6/6 gwei
// transaction shaped like the oracle update, and paid 0.1 gwei/gas. So
//   typed:           maxFeePerGas <= maxPriorityFeePerGas <= cap   (then the key IS the price paid)
//   0x01 / legacy:   gasPrice <= cap                               (gasPrice is both)
// capWei 0n disables the cap half only (the economic gas profile retires the cap, ADR 0011 §2).
export function feeRuleViolation(fees, capWei) {
  if (fees.gasPrice !== undefined) {
    if (capWei > 0n && fees.gasPrice > capWei)
      return { kind: "over_cap", message: `gasPrice ${fees.gasPrice} exceeds the priority-fee cap ${capWei} wei` };
    return null;
  }
  if (fees.maxFeePerGas > fees.maxPriorityFeePerGas)
    return {
      kind: "max_fee_above_tip",
      message:
        `maxFeePerGas ${fees.maxFeePerGas} exceeds maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}: ` +
        "blocks here are ordered by maxFeePerGas while a transaction pays only min(maxFeePerGas, tip) at " +
        "base fee 0, so the excess would buy position without paying for it. Sign maxFeePerGas equal " +
        "to maxPriorityFeePerGas",
    };
  if (capWei > 0n && fees.maxPriorityFeePerGas > capWei)
    return {
      kind: "over_cap",
      message: `maxPriorityFeePerGas ${fees.maxPriorityFeePerGas} exceeds the priority-fee cap ${capWei} wei`,
    };
  return null;
}

// The EVM-executing reads whose gas the caller chooses. Unlike a transaction, nothing signs or pays
// for this gas: the node runs the call up to whatever `gas` the request names, or the block gas limit
// when it names none (320M on the practice devnet, 30M in a backtest).
export const CALL_GAS_METHODS = new Set(["eth_call", "eth_estimateGas", "eth_createAccessList"]);

// Caps the gas of every read in `calls` at `capGas`, in place. Returns how many it rewrote.
//
// A missing, unreadable or over-cap `gas` becomes the cap; one at or under it is left alone. The
// cap is written in rather than refused because every client's default is to leave `gas` out.
// Unreadable is rewritten, not passed: a cap that forwards what it cannot parse is not a cap.
// `gasLimit` is dropped because a node that reads it as an alias of `gas` would run the call on it.
// The call's result does not change under the cap unless it needs more than the cap -- base fee is 0,
// so the gas a call is given does not depend on the caller's balance.
// capGas 0n disables. A call whose first param is not an object is left for the node to refuse.
export function capCallGas(calls, capGas) {
  if (capGas <= 0n) return 0;
  const capHex = "0x" + capGas.toString(16);
  let rewritten = 0;
  for (const c of calls) {
    if (!c || !CALL_GAS_METHODS.has(c.method) || !Array.isArray(c.params)) continue;
    const tx = c.params[0];
    if (!tx || typeof tx !== "object" || Array.isArray(tx)) continue;
    let gas = null;
    try { if (typeof tx.gas === "string" || typeof tx.gas === "number") gas = BigInt(tx.gas); } catch { gas = null; }
    let changed = false;
    if ("gasLimit" in tx) { delete tx.gasLimit; changed = true; }
    if (gas === null || gas < 0n || gas > capGas) { tx.gas = capHex; changed = true; }
    if (changed) rewritten++;
  }
  return rewritten;
}
