// A stale `out/` is the quiet failure mode of a contract change (issue #212).
//
// SimpleLending is deployed per run from the forge artifact, so a tree whose `out/` predates a
// change to the contract deploys the old one. Nothing throws: the valuation's per-user index read
// comes back empty, every lending position marks at zero, and the run still scores and ranks. The
// check is therefore before the deploy, and it names the rebuild.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArtifactHasFunctions } from "../core/src/realtime/marketRegistry.js";

function artifactDir(abi: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-forge-"));
  mkdirSync(join(dir, "SimpleLending.sol"), { recursive: true });
  writeFileSync(
    join(dir, "SimpleLending.sol", "SimpleLending.json"),
    JSON.stringify({ abi, bytecode: { object: "0x00" } }),
  );
  return dir;
}

const fn = (name: string) => ({ type: "function", name, inputs: [], outputs: [] });

test("an artifact without the valuation's read is refused, and the rebuild is named", () => {
  const dir = artifactDir([fn("expectedPosition"), fn("supply")]);
  assert.throws(
    () =>
      assertArtifactHasFunctions(
        "SimpleLending",
        ["userMarketIdsFrom", "userMarketCount", "expectedPosition"],
        dir,
      ),
    (e: Error) => {
      // Both missing names, so one rebuild fixes the whole list.
      assert.match(e.message, /userMarketIdsFrom/);
      assert.match(e.message, /userMarketCount/);
      assert.match(e.message, /npm run build:contracts/);
      return true;
    },
  );
});

test("an artifact that declares them all passes", () => {
  const dir = artifactDir([
    fn("userMarketIdsFrom"),
    fn("userMarketCount"),
    fn("expectedPosition"),
  ]);
  assertArtifactHasFunctions(
    "SimpleLending",
    ["userMarketIdsFrom", "userMarketCount", "expectedPosition"],
    dir,
  );
});

test("a missing artifact still says to build the contracts", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-forge-empty-"));
  assert.throws(
    () => assertArtifactHasFunctions("SimpleLending", ["userMarketCount"], dir),
    /npm run build:contracts/,
  );
});
