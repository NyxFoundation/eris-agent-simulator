// Reading a signed transaction's gas limit without executing it (issue #40 T0).
//
// Its own module so it can be unit-tested: importing gateway.mjs starts a listening server.
// Minimal RLP: enough to read the gas field out of a signed transaction, nothing more.
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

// The gas limit of a signed transaction, or null when it cannot be read.
//
// Null is not "fine": the caller refuses the transaction. A cap that lets through everything it
// cannot parse is not a cap — an unrecognised envelope type would be the whole bypass, and the
// post-run check only notices after the block it starved is gone.
export function txGasLimit(rawHex) {
  try {
    const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
    const buf = Buffer.from(hex, "hex");
    if (buf.length === 0) return null;
    const type = buf[0];
    // Typed envelopes (EIP-2718). Field order differs by type, and gas sits at a different index:
    //   0x02 (1559): chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, ...   -> index 4
    //   0x01 (2930): chainId, nonce, gasPrice, gasLimit, ...                             -> index 3
    //   0x03 (4844): same prefix as 1559                                                 -> index 4
    //   legacy:      nonce, gasPrice, gasLimit, ...                                      -> index 2
    let body = buf;
    let gasIndex;
    if (type === 0x01) { body = buf.subarray(1); gasIndex = 3; }
    // 0x04 (EIP-7702 set-code) shares the 1559 prefix, so the gas limit is at the same index. It is
    // listed explicitly rather than folded into a range: an unrecognised envelope must NOT parse,
    // because the caller treats an unreadable gas limit as a reason to refuse, and a type that
    // happens to put something else at index 4 would silently report the wrong number.
    else if (type === 0x02 || type === 0x03 || type === 0x04) { body = buf.subarray(1); gasIndex = 4; }
    else if (type >= 0xc0) { gasIndex = 2; }
    else return null;
    const outer = rlpDecode(body, 0);
    if (!outer || !outer.list) return null;
    let pos = outer.start;
    for (let i = 0; i <= gasIndex; i++) {
      const item = rlpDecode(body, pos);
      if (!item) return null;
      if (i === gasIndex) {
        if (item.list) return null;
        return BigInt("0x" + (item.value.toString("hex") || "0"));
      }
      pos = item.next;
    }
    return null;
  } catch { return null; }
}

