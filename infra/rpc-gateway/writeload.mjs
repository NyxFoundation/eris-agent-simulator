// Write-throughput / capacity load test. Blasts real signed transactions and measures how many the
// chain actually MINES per block at the competition block time -- the number that decides how many
// participants the trial can hold. Tx signing is CPU-bound (secp256k1) and single-threaded in JS, so
// it is spread across worker_threads to offer enough load to SATURATE anvil (otherwise you measure the
// client, not the chain). A SharedArrayBuffer bounds the unmined backlog so anvil's mempool stays sane.
//   node writeload.mjs --url http://127.0.0.1:8555 --senders 400 --workers 8 --seconds 40 --blocktime 2 --type transfer|approve
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createPublicClient, http, encodeFunctionData, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 31337;
const TOKENS = [ // local ERC20s (constants.local.ts) — approve() is a valid contract call on each, no balance needed
  "0x5FbDB2315678afecb367f032d93F642f64180aa3", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853", "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" ];
const APPROVE_ABI = [{ name: "approve", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];
const key = (i) => keccak256(toHex(`ascon-writeload-${i}`));

// ---------------- worker: sign + send for a disjoint set of accounts ----------------
if (!isMainThread) {
  const { url, indices, type, deadline, maxBacklog, sab, total } = workerData;
  const ctr = new Int32Array(sab); // [0]=submitted, [1]=mined
  const pub = createPublicClient({ transport: http(url) });
  const accts = indices.map((i) => ({ acc: privateKeyToAccount(key(i)), nonce: 0, i }));
  const spender = privateKeyToAccount(key(0)).address;
  const build = (a, seq) => type === "approve"
    ? { to: TOKENS[seq % TOKENS.length], data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender, 1n] }),
        gas: 70000n, gasPrice: 1000000000n, nonce: a.nonce, chainId: CHAIN_ID, type: "legacy" }
    : { to: privateKeyToAccount(key((a.i + 1) % total)).address, value: 1n,
        gas: 21000n, gasPrice: 1000000000n, nonce: a.nonce, chainId: CHAIN_ID, type: "legacy" };
  let seq = 0;
  const run = async () => {
    while (Date.now() < deadline) {
      if (Atomics.load(ctr, 0) - Atomics.load(ctr, 1) > maxBacklog) { await new Promise((r) => setTimeout(r, 15)); continue; }
      const a = accts[seq % accts.length]; seq++;
      try {
        const raw = await a.acc.signTransaction(build(a, seq));
        await pub.request({ method: "eth_sendRawTransaction", params: [raw] });
        a.nonce++; Atomics.add(ctr, 0, 1);
      } catch { await new Promise((r) => setTimeout(r, 5)); }
    }
  };
  // a few concurrent in-flight per worker to overlap RTT with signing of the next
  await Promise.all(Array.from({ length: 6 }, run));
  parentPort.postMessage("done");
}

// ---------------- main: fund, set mining, spawn workers, poll blocks, report ----------------
if (isMainThread) {
  const A = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]); return a; }, []));
  const url = A.url || "http://127.0.0.1:8555";
  const SENDERS = Number(A.senders || 400), WORKERS = Number(A.workers || 8);
  const SECONDS = Number(A.seconds || 40), BT = Number(A.blocktime || 2), TYPE = A.type || "transfer";
  const MAX_BACKLOG = Number(A.backlog || 40000);
  const pub = createPublicClient({ transport: http(url) });
  const rpc = (m, p) => pub.request({ method: m, params: p });

  console.log(`writeload type=${TYPE} senders=${SENDERS} workers=${WORKERS} ${SECONDS}s blocktime=${BT}s`);
  await rpc("evm_setAutomine", [false]);
  await rpc("evm_setIntervalMining", [BT]);
  await rpc("anvil_setBlockGasLimit", ["0x1312D000"]); // 320M — match the competition (reset.sh sets this AFTER load-state)
  const big = "0x21e19e0c9bab2400000"; // 10000 ETH
  await Promise.all(Array.from({ length: SENDERS }, (_, i) => rpc("anvil_setBalance", [privateKeyToAccount(key(i)).address, big])));

  const sab = new SharedArrayBuffer(8);
  const ctr = new Int32Array(sab);
  const startBlock = Number(await pub.getBlockNumber());
  const t0 = Date.now(), deadline = t0 + SECONDS * 1000;

  const workers = Array.from({ length: WORKERS }, (_, w) => {
    const indices = []; for (let i = w; i < SENDERS; i += WORKERS) indices.push(i);
    return new Worker(new URL(import.meta.url), { workerData: { url, indices, type: TYPE, deadline, maxBacklog: MAX_BACKLOG, sab, total: SENDERS } });
  });

  const blocks = [];
  let last = startBlock;
  while (Date.now() < deadline + 5000) {
    try {
      const n = Number(await pub.getBlockNumber());
      for (let bn = last + 1; bn <= n; bn++) {
        const blk = await pub.getBlock({ blockNumber: BigInt(bn) });
        blocks.push({ n: bn, txs: blk.transactions.length, ts: Number(blk.timestamp) });
      }
      if (n > last) { last = n; Atomics.store(ctr, 1, blocks.reduce((s, b) => s + b.txs, 0)); }
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await Promise.all(workers.map((w) => w.terminate()));

  const steady = blocks.slice(1, -1).filter((b) => b.txs > 0);
  const perBlock = steady.map((b) => b.txs);
  const span = steady.length > 1 ? steady[steady.length - 1].ts - steady[0].ts : 0;
  const minedSteady = perBlock.reduce((s, x) => s + x, 0);
  const minedPerSec = span > 0 ? minedSteady / span : 0;
  const submitted = Atomics.load(ctr, 0), mined = blocks.reduce((s, b) => s + b.txs, 0);
  const dur = (Date.now() - t0) / 1000;
  const q = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  const ceilBlk = Math.round(minedPerSec * BT);

  console.log("\n=== RESULT ===");
  console.log(`type / blocktime  ${TYPE} / ${BT}s`);
  console.log(`duration          ${dur.toFixed(0)}s   submitted ${submitted}  submit-rate ${(submitted / dur).toFixed(0)} tx/s`);
  console.log(`blocks (steady)   ${steady.length}`);
  console.log(`tx/block          mean ${(minedSteady / (perBlock.length || 1)).toFixed(0)}  p50 ${q(perBlock, 0.5)}  max ${Math.max(0, ...perBlock)}`);
  console.log(`MINED throughput  ${minedPerSec.toFixed(0)} tx/s   (ceiling per block ~${ceilBlk})`);
  console.log(`backlog at end    ${submitted - mined} unmined  ${submitted - mined > 5000 ? "[SATURATED -> this is anvil's ceiling]" : "[not saturated -> offer more load]"}`);
  console.log("participant capacity (ceiling / tx-per-participant-per-block):");
  for (const b of [1, 2, 3]) console.log(`  ${b}/block -> ${Math.floor(ceilBlk / b)} participants`);
  process.exit(0);
}
