// The flow relay's nonce race (issue #148) and the per-wallet serialization that removes it. The
// sender below resolves its nonce the way an unmanaged viem account does -- the chain's pending
// count, read before the send lands -- so two overlapping sends from one wallet pick the same one.
import test from "node:test";
import assert from "node:assert/strict";
import { KeyedSerial } from "../core/src/realtime/keyedSerial.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeChain() {
  const pending = new Map<string, number>();
  return {
    async send(wallet: string): Promise<number> {
      const nonce = pending.get(wallet) ?? 0; // eth_getTransactionCount(wallet, "pending")
      await sleep(5); // sign + eth_sendRawTransaction
      pending.set(wallet, nonce + 1);
      return nonce;
    },
  };
}

test("overlapping sends from one wallet pick the same nonce (the race)", async () => {
  const chain = fakeChain();
  const nonces = await Promise.all([
    chain.send("flow-curve:informed"),
    chain.send("flow-curve:informed"),
  ]);
  assert.deepEqual(nonces, [0, 0]);
});

test("serialized per wallet, overlapping batches get consecutive nonces", async () => {
  const chain = fakeChain();
  const serial = new KeyedSerial();
  const w = "flow-curve:informed";
  const nonces = await Promise.all([
    serial.run(w, () => chain.send(w)),
    serial.run(w, () => chain.send(w)),
    serial.run(w, () => chain.send(w)),
  ]);
  assert.deepEqual(nonces, [0, 1, 2]);
});

test("different wallets still send concurrently", async () => {
  const serial = new KeyedSerial();
  const events: string[] = [];
  const task = (id: string) => async () => {
    events.push(`start ${id}`);
    await sleep(10);
    events.push(`end ${id}`);
  };
  await Promise.all([serial.run("a", task("a")), serial.run("b", task("b"))]);
  assert.deepEqual(events.slice(0, 2).sort(), ["start a", "start b"]);
});

test("a failed send does not block the wallet's next one, and nothing is kept once idle", async () => {
  const serial = new KeyedSerial();
  const failed = serial.run("w", async () => {
    throw new Error("replacement transaction underpriced");
  });
  const next = serial.run("w", async () => "sent");
  await assert.rejects(failed, /underpriced/);
  assert.equal(await next, "sent");
  await sleep(0);
  assert.equal(serial.pendingKeys, 0);
});
