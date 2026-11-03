// The background flow's relay (core/src/realtime/flowRelay.ts). On the practice devnet each
// gap-closing wallet could send ~1.24 orders a block against the bot's ~2, the per-wallet queue grew
// without end, and the coordinator was sending orders made a day earlier -- re-quoted against the
// current pool, so they landed, but pointed at a market that no longer existed (the WETH pools
// reached 7.3x of fair). These tests model that: a block every BLOCK_MS, two orders a block per
// wallet, and sends slower than the bot.
import test from "node:test";
import assert from "node:assert/strict";
import { FlowRelay } from "../core/src/realtime/flowRelay.js";
import { KeyedSerial } from "../core/src/realtime/keyedSerial.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Order = { wallet: string; round: number; leg: string };

const BLOCK_MS = 20;
// 1.6 sends per block of wall time for two orders a block: the practice devnet's ratio.
const SEND_MS = 16;

// Drive `blocks` blocks: advance the head, then hand over that block's two orders per wallet.
async function drive(
  blocks: number,
  wallets: string[],
  push: (round: number, orders: Order[]) => void,
  setHead: (b: number) => void,
): Promise<void> {
  for (let b = 1; b <= blocks; b++) {
    setHead(b);
    push(
      b,
      wallets.flatMap((wallet) => [
        { wallet, round: b, leg: "WETH" },
        { wallet, round: b, leg: "WBTC" },
      ]),
    );
    await sleep(BLOCK_MS);
  }
}

test("the unbounded per-wallet queue falls further behind every block (the bug)", async () => {
  let head = 0;
  const serial = new KeyedSerial();
  const ages: number[] = [];
  const pending: Promise<unknown>[] = [];
  await drive(
    40,
    ["uniswap:informed"],
    (_round, orders) => {
      for (const o of orders)
        pending.push(
          serial.run(o.wallet, async () => {
            ages.push(head - o.round);
            await sleep(SEND_MS);
          }),
        );
    },
    (b) => (head = b),
  );
  // Sends of the last blocks are still sitting in the queue when the 40th block arrives, and the
  // lag of each send grows with the block number -- it never comes back.
  const early = Math.max(...ages.slice(0, 10));
  const late = Math.max(...ages);
  assert.ok(late > early + 5, `lag should grow: early ${early}, late ${late}`);
  await Promise.all(pending);
});

test("the relay never sends an order more than maxAgeBlocks behind the head", async () => {
  let head = 0;
  const sentAges: number[] = [];
  const relay = new FlowRelay<Order>({
    walletOf: (o) => o.wallet,
    send: async (o) => {
      sentAges.push(head - o.round);
      await sleep(SEND_MS);
    },
    head: () => head,
    maxAgeBlocks: 2,
  });
  await drive(
    40,
    ["uniswap:informed", "balancer:informed", "curve:informed"],
    (round, orders) => relay.push(round, orders),
    (b) => (head = b),
  );
  await relay.idle();
  const stats = relay.drainStats();
  assert.ok(sentAges.length > 0);
  assert.ok(Math.max(...sentAges) <= 2, `max age ${Math.max(...sentAges)}`);
  // It cannot send everything -- the sends are slower than the bot -- and says so instead.
  assert.ok(stats.superseded + stats.stale > 0);
  assert.equal(stats.sent, sentAges.length);
  assert.equal(stats.sent + stats.superseded + stats.stale, 40 * 3 * 2);
});

test("a busy wallet sends the newest block it was given, both legs together", async () => {
  let head = 1;
  const sent: Order[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const relay = new FlowRelay<Order>({
    walletOf: (o) => o.wallet,
    send: async (o) => {
      sent.push(o);
      if (sent.length === 1) await gate;
    },
    head: () => head,
    maxAgeBlocks: 2,
  });
  const block = (round: number): Order[] => [
    { wallet: "w", round, leg: "WETH" },
    { wallet: "w", round, leg: "WBTC" },
  ];
  relay.push(1, block(1)); // round 1's WETH leg goes out and hangs
  head = 2;
  relay.push(2, block(2));
  head = 3;
  relay.push(3, block(3)); // replaces round 2 before the wallet got to it
  release();
  await relay.idle();
  assert.deepEqual(
    sent.map((o) => `${o.round}:${o.leg}`),
    ["1:WETH", "3:WETH", "3:WBTC"],
  );
  const stats = relay.drainStats();
  // Round 1's WBTC leg (overtaken while WETH was in flight) and both legs of round 2.
  assert.equal(stats.superseded, 3);
  assert.equal(stats.stale, 0);
});

test("an order whose block fell behind while its wallet was busy is dropped, not sent", async () => {
  let head = 10;
  const sent: Order[] = [];
  const relay = new FlowRelay<Order>({
    walletOf: (o) => o.wallet,
    send: async (o) => {
      sent.push(o);
      head += 3; // this send took three blocks
    },
    head: () => head,
    maxAgeBlocks: 2,
  });
  relay.push(10, [
    { wallet: "w", round: 10, leg: "WETH" },
    { wallet: "w", round: 10, leg: "WBTC" },
  ]);
  await relay.idle();
  assert.deepEqual(sent.map((o) => o.leg), ["WETH"]);
  assert.equal(relay.drainStats().stale, 1);
});

test("one wallet's slow sends do not hold up another wallet", async () => {
  const head = 1;
  const order: string[] = [];
  const relay = new FlowRelay<Order>({
    walletOf: (o) => o.wallet,
    send: async (o) => {
      await sleep(o.wallet === "slow" ? 50 : 1);
      order.push(o.wallet);
    },
    head: () => head,
    maxAgeBlocks: 2,
  });
  relay.push(1, [
    { wallet: "slow", round: 1, leg: "WETH" },
    { wallet: "fast", round: 1, leg: "WETH" },
  ]);
  await relay.idle();
  assert.deepEqual(order, ["fast", "slow"]);
});

test("a failed send is counted and the wallet carries on; an unknown round is never stale", async () => {
  const sent: string[] = [];
  const relay = new FlowRelay<Order>({
    walletOf: (o) => o.wallet,
    send: async (o) => {
      if (o.leg === "WETH") throw new Error("STF");
      sent.push(o.leg);
    },
    head: () => 1_000,
    maxAgeBlocks: 2,
  });
  relay.push(undefined, [
    { wallet: "w", round: 0, leg: "WETH" },
    { wallet: "w", round: 0, leg: "WBTC" },
  ]);
  await relay.idle();
  assert.deepEqual(sent, ["WBTC"]);
  const stats = relay.drainStats();
  assert.equal(stats.failed, 1);
  assert.equal(stats.sent, 1);
  assert.equal(stats.stale, 0);
  // Reset on read.
  assert.equal(relay.drainStats().failed, 0);
});
