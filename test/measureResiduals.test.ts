import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("residual report preserves sign, population variance, missing samples and direction evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-residuals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "market.json"), JSON.stringify({
    fromBlock: 1, toBlock: 3, granularityBlocks: 1, failedReads: 1,
    bases: ["WBTC"], venues: ["uniswap"],
    series: [
      { block: 1, fair: { WBTC: 99 }, venues: { uniswap: { WBTC: { mid: 100 } } } },
      { block: 2, fair: { WBTC: 101 }, venues: { uniswap: { WBTC: { mid: 100 } } } },
      { block: 3, fair: { WBTC: 100 }, venues: { uniswap: { WBTC: { mid: 0 } } } },
    ],
    notionals: { "0x123": { base: "WBTC", side: "sell" } },
  }));
  writeFileSync(join(dir, "blocks.csv"),
    "ownerId,status,hash,blockNumber\nflow-uniswap:informed,success,0x123,2\n");
  const result = spawnSync(process.env.ERIS_PYTHON || "python3", ["scripts/measureResiduals.py", dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  const stat = report.residuals["WBTC/uniswap"];
  assert.equal(stat.samples, 2);
  assert.equal(stat.missingOrInvalid, 1);
  assert.ok(Math.abs(stat.meanBps) < 1e-9);
  assert.ok(Math.abs(stat.stddevBps - 100) < 1e-9);
  assert.equal(stat.absAbove80BpsFraction, 1);
  assert.deepEqual(report.directionMismatchVsPreviousMid, { "WBTC/uniswap/sell": 1 });
  assert.equal(report.failedReads, 1);
});

test("residual report fails clearly for missing or empty artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-residuals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => spawnSync(process.env.ERIS_PYTHON || "python3", ["scripts/measureResiduals.py", dir], { encoding: "utf8" });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /measureResiduals:.*market.json/);
  writeFileSync(join(dir, "market.json"), JSON.stringify({ series: [] }));
  const empty = run();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /empty market series/);
});
