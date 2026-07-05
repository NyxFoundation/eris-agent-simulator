// Unit tests for core/src/backtest/shared.ts (pure helpers for ADR 0016 backtest).
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  canonicalJson,
  deploymentsFingerprint,
  MANIFEST_FILE_NAME,
  missingVenues,
  readConstantsFingerprint,
  readStateManifest,
  resolveRegimePath,
  STATE_FILE_NAME,
  validateStateManifest,
  type StateManifest,
} from "../core/src/backtest/shared.js";

const tmp = mkdtempSync(join(tmpdir(), "backtest-shared-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function validManifest(): StateManifest {
  const deployments = { chainId: 31337, tokens: { WETH: "0xabc" } };
  return {
    schema: 1,
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceCommit: "deadbeef",
    anvilVersion: "anvil/v1.7.1",
    chainId: 31337,
    genesisHash: "0x63c3",
    stateFile: STATE_FILE_NAME,
    deploymentsFingerprint: deploymentsFingerprint(deployments),
    deployments,
  };
}

describe("canonicalJson / deploymentsFingerprint", () => {
  it("does not depend on key order (equivalent deployments yield the same fingerprint)", () => {
    const a = { b: 1, a: { y: [1, 2], x: "s" } };
    const b = { a: { x: "s", y: [1, 2] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(deploymentsFingerprint(a), deploymentsFingerprint(b));
  });

  it("a value difference shows up in the fingerprint", () => {
    assert.notEqual(
      deploymentsFingerprint({ a: 1 }),
      deploymentsFingerprint({ a: 2 }),
    );
  });

  it("undefined values are ignored (same equivalence as JSON.stringify)", () => {
    assert.equal(
      canonicalJson({ a: 1, b: undefined }),
      canonicalJson({ a: 1 }),
    );
  });

  it("the fingerprint carries a sha256: prefix", () => {
    assert.match(deploymentsFingerprint({}), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("validateStateManifest", () => {
  it("passes a valid manifest", () => {
    const m = validManifest();
    assert.deepEqual(validateStateManifest(m, "test"), m);
  });

  it("rejects schema mismatch / missing fields / fingerprint tampering", () => {
    assert.throws(
      () => validateStateManifest({ ...validManifest(), schema: 2 }, "t"),
      /unsupported schema/,
    );
    assert.throws(
      () => validateStateManifest({ ...validManifest(), genesisHash: "" }, "t"),
      /missing genesisHash/,
    );
    const tampered = {
      ...validManifest(),
      deployments: { chainId: 31337, tokens: { WETH: "0xEVIL" } },
    };
    assert.throws(
      () => validateStateManifest(tampered, "t"),
      /deploymentsFingerprint mismatch/,
    );
  });
});

describe("readStateManifest", () => {
  it("fails with a pointer to gen:state-dump when the manifest is missing", () => {
    assert.throws(() => readStateManifest(join(tmp, "nope")), /gen:state-dump/);
  });

  it("returns the path when both the manifest and state body are present", () => {
    const dir = join(tmp, "state-ok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, MANIFEST_FILE_NAME),
      JSON.stringify(validManifest()),
    );
    writeFileSync(join(dir, STATE_FILE_NAME), "{}");
    const { manifest, statePath } = readStateManifest(dir);
    assert.equal(manifest.chainId, 31337);
    assert.equal(statePath, join(dir, STATE_FILE_NAME));
  });

  it("fails when only the manifest is present without the state body", () => {
    const dir = join(tmp, "state-missing-body");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, MANIFEST_FILE_NAME),
      JSON.stringify(validManifest()),
    );
    assert.throws(() => readStateManifest(dir), /state file not found/);
  });
});

describe("readConstantsFingerprint", () => {
  it("reads the stamp from a generated file (undefined if absent)", () => {
    const path = join(tmp, "constants.local.ts");
    writeFileSync(
      path,
      `import type { Address } from "viem";\n` +
        `export const DEPLOYMENTS_FINGERPRINT = "sha256:abc123";\n` +
        `export const LOCAL_DEPLOYMENT = null;\n`,
    );
    assert.equal(readConstantsFingerprint(path), "sha256:abc123");
    assert.equal(
      readConstantsFingerprint(join(tmp, "does-not-exist.ts")),
      undefined,
    );
  });

  it("an old-generation file without a stamp is undefined (= a regeneration target)", () => {
    const path = join(tmp, "constants.old.ts");
    writeFileSync(path, `export const LOCAL_DEPLOYMENT = null;\n`);
    assert.equal(readConstantsFingerprint(path), undefined);
  });
});

describe("missingVenues", () => {
  const deployments = {
    protocols: {
      common: {},
      uniswapV3: {},
      balancerV2: {},
      curve: {},
      aaveV3: {},
    },
  };

  it("lists venues absent from the state dump (gmx missing)", () => {
    assert.deepEqual(
      missingVenues(
        ["uniswap", "balancer", "curve", "gmx", "aave"],
        deployments,
      ),
      ["gmx"],
    );
  });

  it("empty when everything is present", () => {
    assert.deepEqual(
      missingVenues(["uniswap", "balancer", "curve", "aave"], deployments),
      [],
    );
  });

  it("a protocol name absent from the mapping is treated as missing, fail-closed (guards against forgetting to update for a new venue)", () => {
    assert.deepEqual(missingVenues(["unknown-venue"], deployments), [
      "unknown-venue",
    ]);
  });
});

describe("resolveRegimePath", () => {
  it("a name resolves to config/regimes/<name>.yaml, a path spec resolves as-is", () => {
    const root = join(tmp, "root");
    mkdirSync(join(root, "config", "regimes"), { recursive: true });
    writeFileSync(join(root, "config", "regimes", "calm-01.yaml"), "run: {}\n");
    assert.equal(
      resolveRegimePath(root, "calm-01"),
      join(root, "config", "regimes", "calm-01.yaml"),
    );
    assert.equal(
      resolveRegimePath(root, "config/regimes/calm-01.yaml"),
      join(root, "config", "regimes", "calm-01.yaml"),
    );
  });

  it("fails with a list of available regimes when not found", () => {
    const root = join(tmp, "root");
    assert.throws(
      () => resolveRegimePath(root, "spike-99"),
      /regime not found: spike-99.*available: calm-01/s,
    );
  });
});
