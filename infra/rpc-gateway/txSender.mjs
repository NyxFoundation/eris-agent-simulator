// Recovering the signer of a signed transaction (the sender check in gateway.mjs).
//
// The gateway is dependency-free .mjs that runs on the box with no build step, and Node's crypto has
// neither keccak-256 (OpenSSL's "sha3-256" is the FIPS padding, a different hash) nor ECDSA public
// key recovery. So both are here, in plain BigInt / Uint32 arithmetic: keccak-f[1600], RLP enough to
// rebuild the signing payload, and secp256k1 recovery Q = r^-1 (s·R − e·G).
//
// Its own module for the same reason as txGas.mjs: importing gateway.mjs starts a listening server.

// ---- keccak-256 ----

const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
// rho rotation offsets and pi destinations, lane index x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI = new Array(25);
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

// s: Uint32Array(50), lane i = (lo s[2i], hi s[2i+1])
function keccakF(s) {
  const C = new Uint32Array(10), B = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const a = (x + 4) % 5, b = (x + 1) % 5;
      const lo = C[2 * a] ^ ((C[2 * b] << 1) | (C[2 * b + 1] >>> 31));
      const hi = C[2 * a + 1] ^ ((C[2 * b + 1] << 1) | (C[2 * b] >>> 31));
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= lo; s[2 * (x + y) + 1] ^= hi; }
    }
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i], hi = s[2 * i + 1], r = ROT[i], d = PI[i];
      if (r === 0) { B[2 * d] = lo; B[2 * d + 1] = hi; }
      else if (r < 32) { B[2 * d] = (lo << r) | (hi >>> (32 - r)); B[2 * d + 1] = (hi << r) | (lo >>> (32 - r)); }
      else if (r === 32) { B[2 * d] = hi; B[2 * d + 1] = lo; }
      else { const q = r - 32; B[2 * d] = (hi << q) | (lo >>> (32 - q)); B[2 * d + 1] = (lo << q) | (hi >>> (32 - q)); }
    }
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) {
      const i = x + y, b1 = (x + 1) % 5 + y, b2 = (x + 2) % 5 + y;
      s[2 * i] = B[2 * i] ^ (~B[2 * b1] & B[2 * b2]);
      s[2 * i + 1] = B[2 * i + 1] ^ (~B[2 * b1 + 1] & B[2 * b2 + 1]);
    }
    s[0] ^= RC[round][0]; s[1] ^= RC[round][1];
  }
}

/** keccak-256 (Ethereum's, original padding 0x01) of a Buffer/Uint8Array. Returns a Buffer. */
export function keccak256(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] ^= view.getUint32(off + 4 * i, true);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(s[i], 4 * i);
  return out;
}

// ---- RLP: read items, re-wrap a run of them as a list ----

function rlpItem(buf, pos, end) {
  if (pos >= end) return null;
  const b = buf[pos];
  let start, len, list;
  if (b <= 0x7f) { start = pos; len = 1; list = false; }
  else if (b <= 0xb7) { start = pos + 1; len = b - 0x80; list = false; }
  else if (b <= 0xbf) {
    const ll = b - 0xb7;
    if (pos + 1 + ll > end) return null;
    len = Number(BigInt("0x" + buf.subarray(pos + 1, pos + 1 + ll).toString("hex")));
    start = pos + 1 + ll; list = false;
  } else if (b <= 0xf7) { start = pos + 1; len = b - 0xc0; list = true; }
  else {
    const ll = b - 0xf7;
    if (pos + 1 + ll > end) return null;
    len = Number(BigInt("0x" + buf.subarray(pos + 1, pos + 1 + ll).toString("hex")));
    start = pos + 1 + ll; list = true;
  }
  if (start + len > end) return null;
  return { pos, start, end: start + len, list };
}

// The items of the list at `pos`, or null. Each item keeps its raw encoding span [pos, end).
function rlpList(buf, pos, end) {
  const outer = rlpItem(buf, pos, end);
  if (!outer || !outer.list) return null;
  const items = [];
  for (let p = outer.start; p < outer.end;) {
    const it = rlpItem(buf, p, outer.end);
    if (!it) return null;
    items.push(it);
    p = it.end;
  }
  return { outer, items };
}

function lengthPrefix(base, len) {
  if (len <= 55) return Buffer.from([base + len]);
  let hex = len.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const lb = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([base + 55 + lb.length]), lb]);
}
const rlpWrapList = (payload) => Buffer.concat([lengthPrefix(0xc0, payload.length), payload]);
function rlpScalar(n) {
  if (n === 0n) return Buffer.from([0x80]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const b = Buffer.from(hex, "hex");
  return b.length === 1 && b[0] <= 0x7f ? b : Buffer.concat([lengthPrefix(0x80, b.length), b]);
}
const scalar = (buf, it) => (it.list ? null : BigInt("0x" + (buf.subarray(it.start, it.end).toString("hex") || "0")));

// ---- secp256k1 ----

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => { const r = a % m; return r < 0n ? r + m : r; };
function powMod(b, e, m) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
// Inverse by extended Euclid (faster than Fermat in BigInt).
function inv(a, m) {
  let [r0, r1] = [mod(a, m), m], [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}

// Jacobian points [X, Y, Z]; Z = 0n is infinity.
const INF = [0n, 1n, 0n];
function jDouble([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const YY = (Y * Y) % P, S = (4n * X * YY) % P, M = (3n * X * X) % P;
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * YY * YY), (2n * Y * Z) % P];
}
function jAdd(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = (Z1 * Z1) % P, Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P, U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P, S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? jDouble(p) : INF;
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = (H * H) % P, HHH = (H * HH) % P, V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - 2n * V);
  return [X3, mod(R * (V - X3) - S1 * HHH), (Z1 * Z2 * H) % P];
}
// a·A + b·B in one pass (Shamir's trick).
function mulAdd(a, A, b, B) {
  const AB = jAdd(A, B);
  let acc = INF;
  for (let i = BigInt(Math.max(a.toString(2).length, b.toString(2).length) - 1); i >= 0n; i--) {
    acc = jDouble(acc);
    const ba = (a >> i) & 1n, bb = (b >> i) & 1n;
    if (ba && bb) acc = jAdd(acc, AB); else if (ba) acc = jAdd(acc, A); else if (bb) acc = jAdd(acc, B);
  }
  return acc;
}

// The address that signed digest e with (r, s, recovery bit), or null.
function recoverAddress(digest, r, s, yParity) {
  if (r <= 0n || r >= N || s <= 0n || s >= N || (yParity !== 0n && yParity !== 1n)) return null;
  const x = r;   // r + N is not representable in an Ethereum signature (v carries one bit)
  const y2 = mod(x * x * x + 7n);
  let y = powMod(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null;
  if ((y & 1n) !== yParity) y = P - y;
  const e = mod(BigInt("0x" + digest.toString("hex")), N);
  const rInv = inv(r, N);
  const Q = mulAdd(mod(-e * rInv, N), [G[0], G[1], 1n], mod(s * rInv, N), [x, y, 1n]);
  if (Q[2] === 0n) return null;
  const zInv = inv(Q[2], P), zz = (zInv * zInv) % P;
  const qx = (Q[0] * zz) % P, qy = (Q[1] * zz * zInv) % P;
  const pub = Buffer.from(qx.toString(16).padStart(64, "0") + qy.toString(16).padStart(64, "0"), "hex");
  return "0x" + keccak256(pub).subarray(12).toString("hex");
}

/**
 * The lowercase 0x address that signed this raw transaction, or null when it cannot be recovered.
 *
 * Null is not "fine": the gateway refuses a transaction whose signer it cannot establish, for the
 * same reason the gas cap refuses a gas limit it cannot read -- a check that passes what it does
 * not understand is bypassed by sending something it does not understand.
 *
 * Envelopes: legacy (pre-EIP-155 v 27/28 and EIP-155), and typed 0x01-0x04. A typed body's signing
 * payload is `type || rlp(every field but the last three)` (yParity, r, s) for all four; 0x03 may
 * arrive in its network form `type || rlp([tx, blobs, commitments, proofs])`, which is unwrapped.
 */
export function txSender(rawHex) {
  try {
    if (typeof rawHex !== "string") return null;
    const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
    if (hex.length === 0 || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    const buf = Buffer.from(hex, "hex");
    const type = buf[0];
    if (type >= 0xc0) {
      const l = rlpList(buf, 0, buf.length);
      if (!l || l.outer.end !== buf.length || l.items.length !== 9) return null;
      const [v, r, s] = l.items.slice(6).map((it) => scalar(buf, it));
      if (v === null || r === null || s === null) return null;
      const fields = buf.subarray(l.items[0].pos, l.items[5].end);
      let payload, yParity;
      if (v === 27n || v === 28n) { payload = rlpWrapList(fields); yParity = v - 27n; }
      else if (v >= 35n) {
        const chainId = (v - 35n) >> 1n;
        yParity = (v - 35n) & 1n;
        payload = rlpWrapList(Buffer.concat([fields, rlpScalar(chainId), rlpScalar(0n), rlpScalar(0n)]));
      } else return null;
      return recoverAddress(keccak256(payload), r, s, yParity);
    }
    if (type < 0x01 || type > 0x04) return null;
    let l = rlpList(buf, 1, buf.length);
    if (!l || l.outer.end !== buf.length) return null;
    if (type === 0x03 && l.items.length === 4 && l.items[0].list) {
      l = rlpList(buf, l.items[0].pos, l.items[0].end);
      if (!l) return null;
    }
    const minFields = { 1: 11, 2: 12, 3: 14, 4: 13 }[type];
    if (l.items.length !== minFields) return null;
    const n = l.items.length;
    const [yParity, r, s] = l.items.slice(n - 3).map((it) => scalar(buf, it));
    if (yParity === null || r === null || s === null) return null;
    const payload = Buffer.concat([Buffer.from([type]), rlpWrapList(buf.subarray(l.items[0].pos, l.items[n - 4].end))]);
    return recoverAddress(keccak256(payload), r, s, yParity);
  } catch { return null; }
}
