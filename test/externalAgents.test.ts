// ADR 0021 §2: a participant on the practice devnet registers, and runs the agent themselves.
//
// The environment keeps doing everything it did -- fund, attribute, score, rule-check -- because all
// of that was already address-based. What it stops doing is starting a process. These tests pin the
// two halves of that: a roster entry that describes how to *start* something is refused rather than
// ignored, and the manifest that replaces the coordinator's env carries no secrets and no timings.
import test from "node:test";
import assert from "node:assert/strict";
import { validateAgentsFile } from "../core/src/config.js";
import { buildManifest, isLoopbackUrl } from "../core/src/manifest.js";
import { loadConfig } from "@eris/sdk/config.js";
import { buildSource } from "@eris/sdk/runConfig.js";
import { parseStressEvents } from "../core/src/realtime/events.js";

const roster = (agents: unknown[]) => ({ agents });

test("an external entry registers an address without a wallet binding", () => {
  const [spec] = validateAgentsFile(
    roster([
      {
        id: "alice",
        external: true,
        address: "0x1111111111111111111111111111111111111111",
      },
    ]),
    "test",
  );
  assert.equal(spec.external, true);
  assert.equal(spec.address, "0x1111111111111111111111111111111111111111");
  assert.equal(spec.wallet, undefined);
});

test("an external entry may still take a wallet the operator issues", () => {
  const [spec] = validateAgentsFile(
    roster([{ id: "bob", external: true, wallet: "AUTO" }]),
    "test",
  );
  assert.equal(spec.external, true);
  assert.equal(spec.wallet, "AUTO");
});

test("spawn fields on an external entry are refused, not ignored", () => {
  // Silently ignoring them is the bad outcome: the roster would read as if the operator were
  // running the agent, and nothing would say otherwise until the participant asked why they had no
  // trades.
  for (const extra of [
    { command: "node" },
    { args: ["x"], command: "node" },
    { dir: "clean-arb" },
    { env: { K: "v" } },
  ]) {
    assert.throws(
      () =>
        validateAgentsFile(
          roster([{ id: "a", external: true, wallet: "AUTO", ...extra }]),
          "test",
        ),
      /no meaning for an external agent/,
    );
  }
});

test("address is external-only, exclusive with wallet, and unique", () => {
  assert.throws(
    () =>
      validateAgentsFile(
        roster([
          { id: "a", address: "0x1111111111111111111111111111111111111111" },
        ]),
        "test",
      ),
    /only for external agents/,
  );
  assert.throws(
    () =>
      validateAgentsFile(
        roster([
          {
            id: "a",
            external: true,
            wallet: "AUTO",
            address: "0x1111111111111111111111111111111111111111",
          },
        ]),
        "test",
      ),
    /Pick one/,
  );
  assert.throws(
    () =>
      validateAgentsFile(
        roster([
          {
            id: "a",
            external: true,
            address: "0x1111111111111111111111111111111111111111",
          },
          {
            id: "b",
            external: true,
            address: "0x1111111111111111111111111111111111111111",
          },
        ]),
        "test",
      ),
    /registers address .* twice/,
  );
  assert.throws(
    () =>
      validateAgentsFile(
        roster([{ id: "a", external: true, address: "not-an-address" }]),
        "test",
      ),
    /20-byte hex address/,
  );
});

test("a local entry still needs a wallet, and says so", () => {
  assert.throws(
    () => validateAgentsFile(roster([{ id: "a" }]), "test"),
    /wallet must be one of/,
  );
});

function manifestFixture() {
  const config = {
    ...loadConfig({
      ENABLED_PROTOCOLS: "uniswap",
      ERIS_INTERVAL_BLOCKS: "12",
      ERIS_BLOCK_TIME_SEC: "2",
    }),
    stressEvents: parseStressEvents(
      JSON.stringify([
        {
          type: "crash",
          magnitudeRange: [0.1, 0.2],
          windowFrac: [0.3, 0.7],
          rampBlocks: 3,
          holdBlocks: 6,
          decayBlocks: 8,
        },
        {
          type: "crash",
          magnitudeRange: [0.1, 0.2],
          windowFrac: [0.1, 0.4],
          rampBlocks: 3,
          holdBlocks: 6,
          decayBlocks: 8,
        },
        { type: "whale", magnitudeRange: [1, 2], windowFrac: [0.2, 0.8] },
      ]),
    ),
    vulnEvents: [],
  };
  return buildManifest({
    config,
    priceFeed: "0x2222222222222222222222222222222222222222",
    participants: [
      {
        id: "alice",
        address: "0x1111111111111111111111111111111111111111",
        external: true,
        baseline: false,
      },
    ],
  });
}

test("the manifest publishes what a self-hosted agent needs to connect", () => {
  const m = manifestFixture();
  assert.equal(m.schema, "eris-environment-manifest/1");
  assert.equal(
    m.contracts.priceFeed,
    "0x2222222222222222222222222222222222222222",
  );
  assert.ok(m.chain.rpcUrl && m.chain.chainId > 0);
  assert.deepEqual(m.protocols, ["uniswap"]);
  assert.deepEqual(m.actions.uniswap, [
    "swap",
    "mintLiquidity",
    "removeLiquidity",
    "collectFees",
    // Issue #40: creating a market is a Uniswap action because it goes through that factory.
    "createPool",
  ]);
  assert.equal(m.round.intervalBlocks, 12);
  // Issue #140: a runtime that read the old key still finds it, with the same number.
  assert.equal(m.round.epochBlocks, 12);
  assert.equal(m.round.approxSeconds, 24);
  assert.equal(m.participants[0].external, true);
});

test("the manifest states the whole endowment, the basket's other bases included", () => {
  const m = buildManifest({
    config: {
      ...loadConfig({ ENABLED_PROTOCOLS: "uniswap" }),
      initialBaseAmounts: { WETH: 8n, WBTC: 40_000_000n },
      stressEvents: [],
      vulnEvents: [],
    },
    priceFeed: "0x2222222222222222222222222222222222222222",
    participants: [],
  });
  assert.equal(m.funding.wbtcUnits, "40000000");
  // WETH is already `wethWei`; it is not stated twice.
  assert.equal("wethUnits" in m.funding, false);
});

test("the manifest says the standings are practice, in the document itself", () => {
  // Not only on the standings page: this file is what gets pasted into a README, and provenance
  // that travels separately from a ranking is provenance that will be lost (ADR 0021 §1).
  const m = manifestFixture();
  assert.equal(m.status.scored, false);
  assert.equal(m.status.label, "practice");
  assert.match(m.status.note, /scenario matrix/);
});

test("the manifest discloses episode kinds and counts, never their windows", () => {
  const m = manifestFixture();
  assert.deepEqual(
    [...m.episodes.kinds].sort((a, b) => a.type.localeCompare(b.type)),
    [
      { type: "crash", count: 2 },
      { type: "whale", count: 1 },
    ],
  );
  // The resolved schedule holds start/end blocks. If any of them ever reaches this document, a
  // participant can wait for the crash instead of trading through it (ADR 0021 §1).
  const text = JSON.stringify(m.episodes);
  for (const leak of ["startBlock", "endBlock", "windowFrac", "blockIndex"])
    assert.equal(text.includes(leak), false, `episodes must not carry ${leak}`);
});

test("the manifest carries no key material", () => {
  // It is written into the run directory, and the dashboard serves that directory over HTTP.
  const text = JSON.stringify(manifestFixture());
  const words = text.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  // 32-byte values do occur legitimately (a Balancer poolId), so the assertion is about the fields
  // a key would arrive in rather than about the shape of the string.
  assert.equal(/privateKey|PRIVATE_KEY|secret|mnemonic/i.test(text), false);
  assert.ok(words.length <= 1, "unexpected 32-byte values in the manifest");
});

test("the manifest names the public RPC, not the coordinator's loopback, when one is set (issue #156)", () => {
  const base = {
    ...loadConfig({
      ENABLED_PROTOCOLS: "uniswap",
      ANVIL_RPC_URL: "http://127.0.0.1:8545",
    }),
    stressEvents: [],
    vulnEvents: [],
  };
  const local = buildManifest({ config: base, participants: [] });
  // Unset, nothing changes: a local run publishes the URL it runs on.
  assert.equal(local.chain.rpcUrl, "http://127.0.0.1:8545");
  assert.equal(isLoopbackUrl(local.chain.rpcUrl), true);

  const hosted = buildManifest({
    config: { ...base, publicRpcUrl: "https://rpc.example.org/" },
    priceFeed: "0x2222222222222222222222222222222222222222",
    participants: [],
  });
  assert.equal(hosted.chain.rpcUrl, "https://rpc.example.org/");
  // readRpcUrl too: a participant who split reads would otherwise read from the operator's replica
  // address, which is as unreachable as the loopback.
  assert.equal(hosted.chain.readRpcUrl, "https://rpc.example.org/");
  assert.equal(isLoopbackUrl(hosted.chain.rpcUrl), false);
  // The per-run address the handout could never carry is in the same document.
  assert.equal(
    hosted.contracts.priceFeed,
    "0x2222222222222222222222222222222222222222",
  );
});

test("run.publicRpcUrl and ERIS_PUBLIC_RPC_URL both set it, and blank means unset", () => {
  assert.equal(loadConfig({}).publicRpcUrl, undefined);
  assert.equal(loadConfig({ ERIS_PUBLIC_RPC_URL: "  " }).publicRpcUrl, undefined);
  assert.equal(
    loadConfig({ ERIS_PUBLIC_RPC_URL: "https://rpc.example.org/" }).publicRpcUrl,
    "https://rpc.example.org/",
  );
  assert.equal(
    loadConfig(buildSource({ run: { publicRpcUrl: "https://yaml.example.org/" } }))
      .publicRpcUrl,
    "https://yaml.example.org/",
  );
  // It moves only what is published: the coordinator still dials its own rpcUrl.
  const c = loadConfig({
    ANVIL_RPC_URL: "http://127.0.0.1:8545",
    ERIS_PUBLIC_RPC_URL: "https://rpc.example.org/",
  });
  assert.equal(c.rpcUrl, "http://127.0.0.1:8545");
  assert.equal(c.readRpcUrl, "http://127.0.0.1:8545");
});

test("isLoopbackUrl", () => {
  for (const u of ["http://127.0.0.1:8545", "http://localhost:8546/", "http://[::1]:8545"])
    assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ["https://ascon-rpc.nyx.foundation/", "http://10.0.0.5:8545", "not a url"])
    assert.equal(isLoopbackUrl(u), false, u);
});
