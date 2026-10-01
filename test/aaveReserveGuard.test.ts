// The Aave Pool may hold only reserves the environment owns (issue #190).
//
// The vendor deploy lists eight test-token reserves next to the shared ones, and the Aave score
// sums every reserve in the Pool. These pin the rule the coordinator refuses a run on: an active
// reserve outside the registry (+ the LST) is a finding whether or not it is frozen, and an
// inactive one is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  strayAaveReserves,
  strayAaveReservesMessage,
  type AaveReserveState,
} from "../core/src/realtime/aaveReserveGuard.js";

const SHARED_USDC = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const LST_SHARE = "0xD49a0e9A4CD5979aE36840f542D2d7f02C4817Be" as Address;
const VENDOR_WETH = "0xc351628EB244ec633d5f21fBD6621e1a683B1181" as Address;
const VENDOR_USDC = "0x7969c5eD335650692Bc04293B07F5BF2e7A673C0" as Address;

const ours = new Set([SHARED_USDC, LST_SHARE].map((a) => a.toLowerCase()));

const reserve = (
  asset: Address,
  over: Partial<AaveReserveState> = {},
): AaveReserveState => ({
  asset,
  active: true,
  frozen: false,
  ltvBps: 8000,
  liquidationThresholdBps: 8250,
  ...over,
});

test("the environment's own reserves are never stray, whatever the address case", () => {
  assert.deepEqual(
    strayAaveReserves(
      [reserve(SHARED_USDC.toUpperCase() as Address), reserve(LST_SHARE)],
      ours,
    ),
    [],
  );
});

test("an active vendor reserve is stray", () => {
  const stray = strayAaveReserves(
    [reserve(SHARED_USDC), reserve(VENDOR_WETH)],
    ours,
  );
  assert.deepEqual(
    stray.map((r) => r.asset),
    [VENDOR_WETH],
  );
});

test("frozen is still stray: what is already supplied keeps counting", () => {
  const stray = strayAaveReserves(
    [reserve(VENDOR_WETH, { frozen: true })],
    ours,
  );
  assert.equal(stray.length, 1);
  assert.match(strayAaveReservesMessage(stray), /frozen/);
});

test("an inactive vendor reserve is not stray (what the deployer leaves)", () => {
  assert.deepEqual(
    strayAaveReserves(
      [
        reserve(VENDOR_WETH, { active: false }),
        reserve(VENDOR_USDC, { active: false }),
      ],
      ours,
    ),
    [],
  );
});

test("the message names the fix for both a local deploy and a running chain", () => {
  const msg = strayAaveReservesMessage([reserve(VENDOR_USDC)]);
  assert.match(msg, new RegExp(VENDOR_USDC));
  assert.match(msg, /npm run deploy -- --keep-fresh/);
  assert.match(msg, /npm run close:aave-vendor/);
});
