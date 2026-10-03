import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { rpc, startAnvil } from "./helpers/localRpc.js";
import {
  NONCES_PER_MS,
  epochNonceFloor,
  raiseNonces,
} from "../core/src/realtime/nonceFloor.js";

// A key standing in for the admin (oracle) key, which is the same in every epoch of a matrix.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const admin = privateKeyToAccount(KEY);
const OLD_PRICE = "0x00000000000000000000000000000000000000aa";
const NEW_PRICE = "0x00000000000000000000000000000000000000bb";
const FEE = 7_000_000_000n; // the oracle fee is a constant, so a replay is never outbid

async function signed(nonce: number, to: Hex): Promise<Hex> {
  return admin.signTransaction({
    chainId: foundry.id,
    type: "eip1559",
    nonce,
    to,
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: FEE,
    maxPriorityFeePerGas: FEE,
  });
}

async function balance(url: string, address: string): Promise<bigint> {
  return BigInt((await rpc(url, "eth_getBalance", [address, "latest"])).body.result as string);
}

// Epoch s mines the admin's update at nonce 0, then the matrix reverts for epoch s+1.
async function epochThenRevert(url: string): Promise<Hex> {
  await rpc(url, "anvil_setBalance", [admin.address, "0xde0b6b3a7640000"]);
  const snapshot = (await rpc(url, "evm_snapshot")).body.result;
  const old = await signed(0, OLD_PRICE);
  assert.ok((await rpc(url, "eth_sendRawTransaction", [old])).body.result);
  await rpc(url, "evm_mine");
  assert.equal(await balance(url, OLD_PRICE), 1n);
  await rpc(url, "evm_revert", [snapshot]);
  await rpc(url, "evm_setAutomine", [false]);
  assert.equal(await balance(url, OLD_PRICE), 0n);
  return old;
}

test(
  "without a floor, epoch s's oracle update replays in epoch s+1 and shuts out the coordinator's",
  { timeout: 20_000 },
  async (t) => {
    const url = await startAnvil(t);
    const old = await epochThenRevert(url);
    assert.ok((await rpc(url, "eth_sendRawTransaction", [old])).body.result, "replay accepted");
    const own = await rpc(url, "eth_sendRawTransaction", [await signed(0, NEW_PRICE)]);
    assert.match(own.body.error?.message ?? "", /underpriced/);
    await rpc(url, "evm_mine");
    assert.equal(await balance(url, OLD_PRICE), 1n, "the stale update is what got mined");
    assert.equal(await balance(url, NEW_PRICE), 0n);
  },
);

test(
  "after raiseNonces, the replay is refused and the coordinator's update lands",
  { timeout: 20_000 },
  async (t) => {
    const url = await startAnvil(t);
    const client = createPublicClient({ chain: foundry, transport: http(url) });
    const old = await epochThenRevert(url);
    const floor = epochNonceFloor();
    const report = await raiseNonces(client, [admin.address, admin.address], floor);
    assert.deepEqual(report, { floor, accounts: 1, raised: 1, alreadyAbove: 0 });
    assert.equal(await client.getTransactionCount({ address: admin.address }), floor);

    const replay = await rpc(url, "eth_sendRawTransaction", [old]);
    assert.match(replay.body.error?.message ?? "", /nonce too low/i);
    assert.ok(
      (await rpc(url, "eth_sendRawTransaction", [await signed(floor, NEW_PRICE)])).body.result,
    );
    await rpc(url, "evm_mine");
    assert.equal(await balance(url, NEW_PRICE), 1n);
    assert.equal(await balance(url, OLD_PRICE), 0n);

    // An account already past the floor is left where it is.
    const again = await raiseNonces(client, [admin.address], floor);
    assert.deepEqual(again, { floor, accounts: 1, raised: 0, alreadyAbove: 1 });
  },
);

test("the floor outruns any epoch's transactions and stays an exact JS number", () => {
  // One epoch from one sender: 360 blocks x 30M gas / 21k gas. Epoch starts are >= 1 s apart.
  const maxPerEpoch = Math.ceil((360 * 30_000_000) / 21_000);
  assert.ok(epochNonceFloor(1_000) - epochNonceFloor(0) > maxPerEpoch);
  assert.equal(NONCES_PER_MS, 1000);
  const year2200 = Date.UTC(2200, 0, 1);
  assert.ok(epochNonceFloor(year2200) < Number.MAX_SAFE_INTEGER);
});
