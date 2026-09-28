// `npm run manifest -- --from-run <dir>`: the handout for a running period is the coordinator's own
// manifest with the public RPC in it (core/src/manifestCli.ts).
//
// A manifest built from the config alone has no PriceFeed (deployed when the period starts) and no
// period start (the block its length counts from, the instant its days are cut from) -- so a
// self-hosted agent could not start from it at all, and had no day to count down if it could.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@eris/sdk/config.js";
import { buildManifest, MANIFEST_FILENAME } from "../core/src/manifest.js";
import { handoutFromRun, readRunManifest } from "../core/src/manifestCli.js";
import { CURRENT_SEGMENT_FILE } from "../core/src/segments.js";

function coordinatorManifest() {
  return buildManifest({
    config: {
      ...loadConfig({
        ENABLED_PROTOCOLS: "uniswap",
        ERIS_RUN_ENDS_AT: "2099-10-31T23:59:59+09:00",
        ERIS_SEGMENT_HOURS: "24",
      }),
      stressEvents: [],
      vulnEvents: [],
    },
    priceFeed: "0x2222222222222222222222222222222222222222",
    periodStart: { block: 77, startedAtMs: Date.parse("2026-09-28T01:00:00Z") },
    participants: [],
  });
}

test("given the period's directory, the handout follows current-segment to today's manifest", () => {
  const competition = mkdtempSync(join(tmpdir(), "eris-handout-"));
  const segment = join(competition, "2026-09-29-s01");
  mkdirSync(segment);
  writeFileSync(
    join(segment, MANIFEST_FILENAME),
    JSON.stringify(coordinatorManifest()),
  );
  writeFileSync(join(competition, CURRENT_SEGMENT_FILE), `${segment}\n`);

  const { manifest, path } = readRunManifest(competition);
  assert.equal(path, join(segment, MANIFEST_FILENAME));
  assert.equal(
    manifest.contracts.priceFeed,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(manifest.period.startBlock, 77);
  assert.equal(manifest.period.startedAt, "2026-09-28T01:00:00.000Z");
});

test("the handout dials the public RPC and keeps everything else the coordinator wrote", () => {
  const original = JSON.parse(JSON.stringify(coordinatorManifest()));
  const handout = handoutFromRun(original, "https://rpc.example/");
  assert.equal(handout.chain.rpcUrl, "https://rpc.example/");
  assert.equal(handout.chain.readRpcUrl, "https://rpc.example/");
  assert.deepEqual(handout.period, original.period);
  assert.deepEqual(handout.contracts, original.contracts);
  assert.notEqual(
    original.chain.rpcUrl,
    "https://rpc.example/",
    "the input is not mutated",
  );
});

test("a directory without a manifest, or a file that is not one, is refused", () => {
  const empty = mkdtempSync(join(tmpdir(), "eris-handout-"));
  assert.throws(() => readRunManifest(empty), /does not exist/);
  writeFileSync(
    join(empty, MANIFEST_FILENAME),
    JSON.stringify({ schema: "other" }),
  );
  assert.throws(() => readRunManifest(empty), /not an environment manifest/);
});
