// core/src/backtest/shared.ts（ADR 0016 backtest の純粋ヘルパ）のユニットテスト。
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
  it("鍵順に依存しない（同値の deployments は同じ fingerprint）", () => {
    const a = { b: 1, a: { y: [1, 2], x: "s" } };
    const b = { a: { x: "s", y: [1, 2] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(deploymentsFingerprint(a), deploymentsFingerprint(b));
  });

  it("値の差は fingerprint に現れる", () => {
    assert.notEqual(
      deploymentsFingerprint({ a: 1 }),
      deploymentsFingerprint({ a: 2 }),
    );
  });

  it("undefined の値は無視される（JSON.stringify と同じ同値性）", () => {
    assert.equal(
      canonicalJson({ a: 1, b: undefined }),
      canonicalJson({ a: 1 }),
    );
  });

  it("fingerprint は sha256: プレフィクス付き", () => {
    assert.match(deploymentsFingerprint({}), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("validateStateManifest", () => {
  it("正しい manifest を通す", () => {
    const m = validManifest();
    assert.deepEqual(validateStateManifest(m, "test"), m);
  });

  it("schema 不一致 / 欠落フィールド / fingerprint 改竄を落とす", () => {
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
  it("manifest 無しは gen:state-dump への誘導付きで fail", () => {
    assert.throws(() => readStateManifest(join(tmp, "nope")), /gen:state-dump/);
  });

  it("manifest + state 本体が揃えばパスを返す", () => {
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

  it("manifest だけで state 本体が無いのは fail", () => {
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
  it("生成ファイルの刻印を読む（無ければ undefined）", () => {
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

  it("刻印の無い旧世代ファイルは undefined（= 再生成の対象）", () => {
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

  it("state dump に無い venue を列挙する（gmx 欠落）", () => {
    assert.deepEqual(
      missingVenues(
        ["uniswap", "balancer", "curve", "gmx", "aave"],
        deployments,
      ),
      ["gmx"],
    );
  });

  it("全て揃っていれば空", () => {
    assert.deepEqual(
      missingVenues(["uniswap", "balancer", "curve", "aave"], deployments),
      [],
    );
  });

  it("未知の protocol 名は検査対象外（coordinator 側の検証に任せる）", () => {
    assert.deepEqual(missingVenues(["unknown-venue"], deployments), []);
  });
});

describe("resolveRegimePath", () => {
  it("名前は config/regimes/<name>.yaml を引き、パス表記はそのまま解決する", () => {
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

  it("見つからなければ利用可能な regime 一覧付きで fail", () => {
    const root = join(tmp, "root");
    assert.throws(
      () => resolveRegimePath(root, "spike-99"),
      /regime not found: spike-99.*available: calm-01/s,
    );
  });
});
