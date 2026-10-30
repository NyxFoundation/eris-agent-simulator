// Every account the environment signs with is on one list (core/src/realtime/environmentWallets.ts),
// and that list is what the RPC gateway seals the pending nonce of.
//
// The gateway answers eth_getTransactionCount(address, "pending") as of "latest" only for the
// addresses it is given. It used to be given the four role keys, and every other environment wallet
// told anyone polling it that the environment had something unmined, a block before it landed: an
// informed flow wallet trades only when the next fair price is more than 30bps from its venue's
// pool, so its bump said where the next price was; a launch wave wallet bumps only for a token that
// is not a dud; the whale's bump named the print. The guard here is that a new environment wallet
// cannot be added without landing on the list.
//
// The regimes fund WBTC, which only the local registry has (constants.ts reads this at import).
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

const { installWalletSecret, environmentKey } = await import("../core/src/walletKeys.js");
installWalletSecret({ source: "file", hex: "11".repeat(32) });

const {
  ENVIRONMENT_KEY_KINDS,
  deriveFlowWallets,
  environmentSigners,
  flowWalletKeys,
  gatewaySealRecord,
} = await import("../core/src/realtime/environmentWallets.js");
const { GATEWAY_SEALED_SENDERS_ENV } = await import("../core/src/realtime/liveWeek.js");
const { isEnvironmentOnlyEnv } = await import("../core/src/realtime/agentProcess.js");
const { ENVIRONMENT_SIGNER_IDS } = await import("../core/src/realtime/environmentSigners.js");
const { loadRunConfig } = await import("../core/src/runConfig.js");
const { privateKeyForWalletName } = await import("../core/src/config.js");
const { resolveEnabledProtocolIds } = await import("../sdk/src/protocols/registry.js");
const { deriveVulnPoolWallet } = await import("../core/src/realtime/vulnPools.js");
const { deriveStressVictims } = await import("../core/src/stressVictims.js");
const { deriveLiquityVictims } = await import("../core/src/liquityVictims.js");
const { LAUNCH_WALLET_SLOTS } = await import("../core/src/realtime/tokenLaunch.js");
const { WHALE_WALLET_KEY } = await import("../core/src/realtime/whale.js");
const { roleKeysFromEnv, scenarioRegimePaths, sealedSenders, sealedSendersArgs } = await import(
  "../scripts/liveWeek.js"
);

const OFFICIAL: string[] = (
  parseYaml(readFileSync(resolve(ROOT, "config/scenarios/public.yaml"), "utf8")) as {
    regimes: string[];
  }
).regimes;

const ROLE_ENV = () => ({
  ADMIN_PRIVATE_KEY: generatePrivateKey(),
  KEEPER_PRIVATE_KEY: generatePrivateKey(),
  SETUP_PRIVATE_KEY: generatePrivateKey(),
  DEPLOYER_PRIVATE_KEY: generatePrivateKey(),
});

const load = (path: string, env: Record<string, string> = ROLE_ENV()) =>
  loadRunConfig(resolve(ROOT, path), env);

// ---- the static half: every environmentKey call is classified, and a signing kind is derived only
// where environmentSigners reads it ----

// Where each signing kind is derived. environmentSigners calls these (deriveFlowWallets,
// deriveVulnPoolWallet, deriveStressVictims, deriveLiquityVictims), so a key of that kind made
// anywhere else is a wallet it does not see.
const DERIVED_IN: Record<string, string> = {
  flow: "core/src/realtime/environmentWallets.ts",
  "vuln-pools": "core/src/realtime/vulnPools.ts",
  "stress-victim": "core/src/stressVictims.ts",
  "liquity-victim": "core/src/liquityVictims.ts",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

// Production code only: the tests derive keys of their own.
const SCANNED = ["core", "sdk", "scripts", "example", "infra", "dashboard/src", "dashboard/server"]
  .map((d) => resolve(ROOT, d))
  .flatMap((d) => {
    try {
      return sourceFiles(d);
    } catch {
      return [];
    }
  });

type CallSite = { file: string; kind: string | null };

// Comments mention `environmentKey(` without calling it. (`//` after a colon is a URL, not a comment.)
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function environmentKeyCalls(): CallSite[] {
  const calls: CallSite[] = [];
  for (const path of SCANNED) {
    const raw = readFileSync(path, "utf8");
    if (!raw.includes("environmentKey")) continue;
    const text = withoutComments(raw);
    const file = relative(ROOT, path);
    // An alias would hide its calls from the scan below.
    assert.doesNotMatch(text, /environmentKey\s+as\s+\w/, `${file} imports environmentKey under another name`);
    for (const m of text.matchAll(/(function\s+)?\benvironmentKey\s*\(\s*([^,)]*)/g)) {
      if (m[1]) continue; // the definition in walletKeys.ts
      const literal = /^"([^"]+)"$|^'([^']+)'$/.exec(m[2].trim());
      calls.push({ file, kind: literal ? (literal[1] ?? literal[2]) : null });
    }
  }
  return calls;
}

test("the scan sees the call sites it is meant to guard", () => {
  const files = new Set(environmentKeyCalls().map((c) => c.file));
  for (const file of Object.values(DERIVED_IN)) assert.ok(files.has(file), `no environmentKey call found in ${file}`);
});

test("every environmentKey call names a literal kind the module classifies", () => {
  for (const { file, kind } of environmentKeyCalls()) {
    assert.ok(kind !== null, `${file}: environmentKey with a non-literal kind cannot be classified`);
    assert.ok(
      kind in ENVIRONMENT_KEY_KINDS,
      `${file}: environmentKey("${kind}", ...) is a kind ENVIRONMENT_KEY_KINDS (core/src/realtime/environmentWallets.ts) ` +
        "does not classify. If its account signs during an epoch, environmentSigners must list it (the gateway " +
        "seals its pending nonce); if not, say why there",
    );
  }
});

test("a signing kind is derived only where environmentSigners reads it", () => {
  const signing = Object.entries(ENVIRONMENT_KEY_KINDS)
    .filter(([, v]) => v.signs)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(Object.keys(DERIVED_IN).sort(), signing, "DERIVED_IN covers exactly the signing kinds");
  for (const { file, kind } of environmentKeyCalls()) {
    if (kind === null || !(kind in DERIVED_IN)) continue;
    assert.equal(
      file,
      DERIVED_IN[kind],
      `environmentKey("${kind}", ...) in ${file}: a ${kind} wallet made outside ${DERIVED_IN[kind]} is one ` +
        "environmentSigners does not list, and the gateway would leave its pending nonce open",
    );
  }
});

test("the coordinator builds its flow map and its nonce floor from the list", () => {
  const src = readFileSync(resolve(ROOT, "core/src/realtime/coordinator.ts"), "utf8");
  assert.match(src, /deriveFlowWallets\(/);
  assert.match(src, /environmentSigners\(config, enabledIds\)/);
  // A wallet added to the map inline would be funded and attributed and never sealed.
  assert.doesNotMatch(src, /flowWalletMap\.set\(/, "the coordinator adds a flow wallet outside deriveFlowWallets");
});

test("every configured private key is a role key, a participant's wallet, or unused", async () => {
  // A key added to SimConfig.privateKeys is a signer nothing here would list until it is classified.
  const configured = Object.keys(load("config/regimes/calm.yaml").config.privateKeys).sort();
  const role = Object.keys(ENVIRONMENT_SIGNER_IDS);
  const participant = ["agent0", "agent1", "agent2", "agent3", "agent4", "agent5", "agent6"];
  // FLOW_UNINFORMED_PRIVATE_KEY / FLOW_INFORMED_PRIVATE_KEY: from before the flow wallets were
  // derived per venue. Nothing signs with them.
  const unused = ["uninformedFlow", "informedFlow"];
  assert.deepEqual(configured, [...role, ...participant, ...unused].sort());
  for (const path of SCANNED) {
    const text = readFileSync(path, "utf8");
    for (const name of unused)
      assert.doesNotMatch(
        text,
        new RegExp(`privateKeys\\s*(\\.\\s*${name}|\\[\\s*["']${name}["']\\s*\\])`),
        `${relative(ROOT, path)} signs with privateKeys.${name}: list it in environmentSigners`,
      );
  }
});

// ---- the dynamic half: on every official regime and the practice period, every wallet the
// coordinator makes is on the list, and no participant's is ----

test("environmentSigners lists every wallet the coordinator signs with", () => {
  for (const path of [...OFFICIAL.map((r) => `config/regimes/${r}.yaml`), "config/practice.yaml"]) {
    const env = { ...ROLE_ENV(), TREASURY_PRIVATE_KEY: generatePrivateKey() };
    const { config, agents } = load(path, env);
    const signers = environmentSigners(config);
    const listed = new Set<string>(signers.map((s) => s.address));
    const has = (address: string, what: string) =>
      assert.ok(listed.has(address.toLowerCase()), `${path}: ${what} ${address} is not listed`);

    // What the coordinator builds, the way it builds it.
    const enabledIds = resolveEnabledProtocolIds(config.enabledProtocols);
    const flow = deriveFlowWallets({ enabledIds, aaveFlowActorCount: config.aaveFlowActorCount });
    for (const [key, w] of flow) has(w.address, `flow wallet ${key}`);
    has(deriveVulnPoolWallet().address, "the vuln pool owner");
    for (const v of deriveStressVictims(config.stressVictimCount)) has(v.address, v.id);
    for (const v of deriveLiquityVictims(config.stressLiquityVictimCount)) has(v.address, v.id);
    for (const name of Object.keys(ENVIRONMENT_SIGNER_IDS))
      has(privateKeyToAccount(config.privateKeys[name as keyof typeof ENVIRONMENT_SIGNER_IDS]).address, name);
    has(privateKeyToAccount(env.TREASURY_PRIVATE_KEY as `0x${string}`).address, "the treasury");

    // The wallets whose pending nonce leaked the most, by name.
    for (const id of enabledIds) {
      has(privateKeyToAccount(environmentKey("flow", `${id}:informed`)).address, `${id}:informed`);
      has(privateKeyToAccount(environmentKey("flow", `${id}:uninformed`)).address, `${id}:uninformed`);
    }
    has(privateKeyToAccount(environmentKey("flow", WHALE_WALLET_KEY)).address, "the whale");
    for (let slot = 0; slot < LAUNCH_WALLET_SLOTS; slot++) {
      has(privateKeyToAccount(environmentKey("flow", `launch:${slot}`)).address, `launch:${slot}`);
      has(privateKeyToAccount(environmentKey("flow", `launch-wave:${slot}`)).address, `launch-wave:${slot}`);
    }
    assert.equal(flow.size, flowWalletKeys({ enabledIds, aaveFlowActorCount: config.aaveFlowActorCount }).length);

    // Every signing kind is represented where the config has it (the victims only where it stages them).
    const kinds = new Set(signers.map((s) => s.kind));
    for (const kind of ["role", "flow", "vuln-pools", "treasury"]) assert.ok(kinds.has(kind as never), `${path}: no ${kind}`);
    if (config.stressVictimCount > 0) assert.ok(kinds.has("stress-victim"), `${path}: no Aave victim`);
    if (config.stressLiquityVictimCount > 0) assert.ok(kinds.has("liquity-victim"), `${path}: no Liquity victim`);

    // A participant's wallet is not the environment's: its pending nonce is what its runtime
    // allocates from.
    for (const a of agents) {
      if (a.wallet !== "AUTO") continue;
      const address = privateKeyToAccount(privateKeyForWalletName(config, a.wallet, a.id)).address;
      assert.ok(!listed.has(address.toLowerCase()), `${path}: agent ${a.id}'s wallet is sealed`);
    }
    assert.equal(listed.size, signers.length, `${path}: an address is listed twice`);
  }
});

test("the official regimes stage the victims the list has to carry", () => {
  // The union below is only as good as this: lending-incident and cdp-incident are not special.
  const counts = OFFICIAL.map((r) => {
    const { config } = load(`config/regimes/${r}.yaml`);
    return [config.stressVictimCount, config.stressLiquityVictimCount];
  });
  assert.ok(counts.every(([a, l]) => a > 0 && l > 0));
});

// ---- the CLI the live week and the practice devnet run ----

function walletSecretFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sealed-senders-"));
  const path = join(dir, "wallet-secret.yaml");
  // Quoted: all digits, YAML would read it as a number.
  writeFileSync(path, `walletSecret: "${"11".repeat(32)}"\n`, { mode: 0o600 });
  return path;
}

test("sealed-senders lists every environment signer over the official set, and no agent", async () => {
  const env = ROLE_ENV();
  const { configs, walletSecretPath } = sealedSendersArgs(
    ["--wallet-secret", walletSecretFile()],
    {},
    ROOT,
  );
  assert.equal(configs.length, OFFICIAL.length, "the official set by default");
  const sealed = await sealedSenders({ env, walletSecretPath, configs });
  assert.deepEqual(sealed.addresses, [...new Set(sealed.addresses)].sort(), "sorted and distinct");
  for (const a of sealed.addresses) assert.match(a, /^0x[0-9a-f]{40}$/);
  const listed = new Set(sealed.addresses);
  for (const k of Object.values(env)) assert.ok(listed.has(privateKeyToAccount(k).address.toLowerCase()));
  for (const key of ["uniswap:informed", "gmx:informed", WHALE_WALLET_KEY, "launch-wave:0", "launch:2"])
    assert.ok(listed.has(privateKeyToAccount(environmentKey("flow", key)).address.toLowerCase()), key);
  // The union over the regimes is every regime's list.
  for (const regime of OFFICIAL) {
    const { config } = load(`config/regimes/${regime}.yaml`, env);
    for (const s of environmentSigners(config)) assert.ok(listed.has(s.address), `${regime}: ${s.id}`);
  }
  assert.ok(!listed.has(privateKeyToAccount(environmentKey("agent", "noop")).address.toLowerCase()));
  assert.equal(sealed.byKind.role, 4);
  assert.equal(sealed.byKind["stress-victim"], 2);
  assert.equal(sealed.byKind["liquity-victim"], 2);
});

test("the coordinator checks its signers against the gateway's list by containment", async () => {
  const env = ROLE_ENV();
  const { configs, walletSecretPath } = sealedSendersArgs(["--wallet-secret", walletSecretFile()], {}, ROOT);
  const union = (await sealedSenders({ env, walletSecretPath, configs })).addresses;
  const { config } = load("config/regimes/calm.yaml", env);
  const signers = environmentSigners(config);
  const seal = (value?: string) =>
    gatewaySealRecord(signers, value === undefined ? {} : { [GATEWAY_SEALED_SENDERS_ENV]: value });

  assert.deepEqual(seal(), { gateway: "unchecked" });
  assert.deepEqual(seal("  "), { gateway: "unchecked" });
  // The week's list is a union over every regime: one epoch's signers are a subset of it, and the
  // case the gateway reads it in does not matter.
  assert.deepEqual(seal(union.join(",")), { gateway: "covered", sealed: union.length });
  assert.equal(seal(union.map((a) => a.toUpperCase().replace("0X", "0x")).join(", ")).gateway, "covered");

  // The list from before: the four role keys only. Every flow wallet is open, and named.
  const roleOnly = Object.values(env).map((k) => privateKeyToAccount(k).address).join(",");
  const old = seal(roleOnly);
  assert.equal(old.gateway, "missing");
  const missing = old.gateway === "missing" ? old.missing.map((m) => m.id) : [];
  assert.ok(missing.includes("flow-uniswap:informed"), missing.join(", "));
  assert.ok(!missing.includes("oracle"), "a role key the list has is not reported");
  assert.equal(missing.length, signers.length - 4);

  // A list made under another week's role keys seals none of this week's role keys.
  const other = seal((await sealedSenders({ env: ROLE_ENV(), walletSecretPath, configs })).addresses.join(","));
  assert.equal(other.gateway === "missing" ? other.missing.length : 0, 4);

  // An address list, but a map of the environment's wallets: never an agent's.
  assert.equal(isEnvironmentOnlyEnv(GATEWAY_SEALED_SENDERS_ENV), true);
});

test("sealed-senders takes a plan's regimes and practice's config", async () => {
  const plan = "k: 2\nepochs:\n  - { s: 1, regime: calm, seed: 1 }\n  - { s: 2, regime: launch, seed: 2 }\n";
  assert.deepEqual(
    scenarioRegimePaths(plan, ROOT),
    [resolve(ROOT, "config/regimes/calm.yaml"), resolve(ROOT, "config/regimes/launch.yaml")],
  );
  const dir = mkdtempSync(join(tmpdir(), "sealed-plan-"));
  writeFileSync(join(dir, "plan.yaml"), plan);
  const secret = walletSecretFile();
  const args = sealedSendersArgs(
    ["--scenarios", join(dir, "plan.yaml"), "--config", resolve(ROOT, "config/practice.yaml")],
    { ERIS_WALLET_SECRET_FILE: secret },
    ROOT,
  );
  assert.equal(args.walletSecretPath, secret);
  assert.equal(args.configs.length, 3);
  const practice = await sealedSenders({
    env: ROLE_ENV(),
    walletSecretPath: secret,
    configs: [resolve(ROOT, "config/practice.yaml")],
  });
  assert.ok(practice.byKind.flow > 0 && practice.byKind.role === 4);
});

test("sealed-senders refuses to guess a role key or the wallet secret", async () => {
  const env = ROLE_ENV();
  assert.throws(() => roleKeysFromEnv({ ...env, DEPLOYER_PRIVATE_KEY: "" }), /DEPLOYER_PRIVATE_KEY/);
  assert.throws(() => roleKeysFromEnv({ ...env, ADMIN_PRIVATE_KEY: "0x1234" }), /ADMIN_PRIVATE_KEY/);
  await assert.rejects(
    sealedSenders({ env: { ...env, KEEPER_PRIVATE_KEY: undefined }, walletSecretPath: walletSecretFile(), configs: ["x"] }),
    /KEEPER_PRIVATE_KEY/,
  );
  // Without a file the keys would come from a random secret: addresses no run uses.
  assert.throws(() => sealedSendersArgs([], {}, ROOT), /wallet secret/);
  assert.throws(() => sealedSendersArgs(["--wallet-secret"], {}, ROOT), /needs a value/);
  assert.throws(() => sealedSendersArgs(["--bogus", "x"], { ERIS_WALLET_SECRET_FILE: "x" }, ROOT), /unknown argument/);
});
