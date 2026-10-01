/**
 * What `close:aave-vendor` acts on, and when it refuses (issue #190).
 *
 * The closer enumerates the Pool's reserves the same way the coordinator's guard does
 * (getReservesList minus the environment's own), so it cannot report success while the guard keeps
 * refusing; and on a local anvil the poc has pinned, a close sent on top of the pin is undone by
 * the next run's resetFork, so the closer has to recognise that pin exactly as the poc does.
 *
 * Pure: no chain, no network. Run with `npm run test:unit`.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import {
  environmentReserveAssets,
  vendorReserves,
  type ReserveDeployments,
} from "../../src/protocols/aave-reserves.js";
import {
  formatLocalSnapshot,
  localSnapshotPath,
  pinnedSnapshotId,
} from "../../src/localSnapshot.js";
import { ROOT } from "../../src/util.js";

const SHARED_WETH = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const SHARED_USDC = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const SHARED_DAI = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const LST_SHARE = "0xD49a0e9A4CD5979aE36840f542D2d7f02C4817Be" as Address;
const VENDOR_WETH = "0xc351628EB244ec633d5f21fBD6621e1a683B1181" as Address;
const VENDOR_LINK = "0x7969c5eD335650692Bc04293B07F5BF2e7A673C0" as Address;
const UNKNOWN = "0x1111111111111111111111111111111111111111" as Address;

const reg: ReserveDeployments = {
  tokens: { WETH: SHARED_WETH, USDC: SHARED_USDC, DAI: SHARED_DAI },
  protocols: { lst: { lstToken: LST_SHARE } },
};
const vendorKeys = new Map([
  [VENDOR_WETH.toLowerCase(), "WETH"],
  [VENDOR_LINK.toLowerCase(), "LINK"],
]);
const SHARED = ["WETH", "USDC", "WBTC"];

describe("vendorReserves", () => {
  it("is every listed reserve but the registry tokens and the LST, whatever the case", () => {
    expect(environmentReserveAssets(reg)).toEqual(
      new Set([SHARED_WETH, SHARED_USDC, SHARED_DAI, LST_SHARE].map((a) => a.toLowerCase())),
    );
    expect(
      vendorReserves(
        [SHARED_WETH.toUpperCase() as Address, SHARED_USDC, LST_SHARE, VENDOR_WETH, VENDOR_LINK],
        reg,
        SHARED,
        vendorKeys,
      ),
    ).toEqual([
      { key: "WETH", asset: VENDOR_WETH },
      { key: "LINK", asset: VENDOR_LINK },
    ]);
  });

  it("closes a listing the vendor deployment files do not name (the guard would refuse it)", () => {
    expect(vendorReserves([SHARED_WETH, SHARED_USDC, UNKNOWN], reg, SHARED, vendorKeys)).toEqual([
      { key: "unknown", asset: UNKNOWN },
    ]);
  });

  it("is empty when the Pool lists only the environment's reserves (nothing to report as closed)", () => {
    expect(vendorReserves([SHARED_WETH, SHARED_USDC, LST_SHARE], reg, SHARED, vendorKeys)).toEqual(
      [],
    );
  });

  it("refuses a deployments.json whose shared reserves this Pool does not list", () => {
    // Another deploy's file: "not ours" would be the shared reserves themselves.
    expect(() =>
      vendorReserves([VENDOR_WETH, VENDOR_LINK], reg, SHARED, vendorKeys),
    ).toThrow(/WETH, USDC/);
  });
});

describe("the poc's .local-snapshot pin", () => {
  const genesis = `0x${"ab".repeat(32)}` as Hex;
  it("pins this chain only when the genesis hash matches, as resetFork reads it", () => {
    expect(pinnedSnapshotId(formatLocalSnapshot(genesis, "0x3"), genesis)).toBe("0x3");
    expect(pinnedSnapshotId(`${genesis.toUpperCase().replace("0X", "0x")}:0x3\n`, genesis)).toBe(
      "0x3",
    );
    expect(pinnedSnapshotId(`0x${"cd".repeat(32)}:0x3`, genesis)).toBeUndefined();
    expect(pinnedSnapshotId("0x3", genesis)).toBeUndefined(); // old bare-id format
    expect(pinnedSnapshotId(undefined, genesis)).toBeUndefined();
  });

  it("lives in the repo root by default, where sim:realtime and gen:state-dump look", () => {
    expect(localSnapshotPath({})).toBe(resolve(ROOT, "..", ".local-snapshot"));
    expect(localSnapshotPath({ ERIS_LOCAL_SNAPSHOT_FILE: "runs/x.snap" })).toBe(
      resolve(ROOT, "..", "runs/x.snap"),
    );
  });
});
