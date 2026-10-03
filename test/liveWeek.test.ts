// The live week refuses what is only a warning elsewhere (core/src/realtime/liveWeek.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import type { AgentSpec } from "../sdk/src/types.js";
import {
  LiveWeekRefusal,
  isLiveWeekRefusal,
  liveWeekRefusals,
  publicAccountRefusal,
  stateDumpRefusal,
} from "../core/src/realtime/liveWeek.js";
import {
  participantsCanSend,
  publicTestAccountsInDump,
  publicTestAddresses,
  type RoleKeys,
} from "../core/src/realtime/roleKeyGuard.js";

const secret = (): RoleKeys => ({
  admin: generatePrivateKey(),
  keeper: generatePrivateKey(),
  setup: generatePrivateKey(),
  deployer: generatePrivateKey(),
});
const privateAdmin = (): Address =>
  privateKeyToAccount(generatePrivateKey()).address;
const ANVIL_0: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const field: AgentSpec[] = [
  { id: "unit-a", wallet: "AUTO" },
  { id: "unit-b", wallet: "AUTO" },
];
const isolated = { ERIS_AGENT_ISOLATE: "1", ERIS_AGENT_INTERNAL: "1" };

const posture = (
  over: Partial<Parameters<typeof liveWeekRefusals>[0]> = {},
): string[] =>
  liveWeekRefusals({
    keys: secret(),
    use: { marketRegistry: true },
    venueAdmin: privateAdmin(),
    sandbox: "docker",
    agents: field,
    env: isolated,
    platform: "linux",
    ...over,
  });

test("private keys and isolated containers pass", () => {
  assert.deepEqual(posture(), []);
});

test("the live week is a chain participants can send to, with no external entry and no registrations file", () => {
  assert.equal(participantsCanSend({ agents: field }), false);
  assert.equal(participantsCanSend({ agents: field, liveWeek: true }), true);
});

test("a public environment key is refused, and the rehearsal switch does not reopen it", () => {
  const keys = { ...secret(), admin: ANVIL_0_KEY };
  const reasons = posture({
    keys,
    env: { ...isolated, ERIS_ALLOW_PUBLIC_ROLE_KEYS: "1" },
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /public keys: admin key/);
});

test("a dump deployed on the default mnemonic is refused through the venue admin", () => {
  const reasons = posture({ venueAdmin: ANVIL_0 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /venue admin/);
});

test("agents as plain processes are refused", () => {
  const reasons = posture({ sandbox: "process" });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /agentSandbox is process/);
});

test("a command/args entry is refused: it starts outside the container", () => {
  const reasons = posture({
    agents: [...field, { id: "own-binary", wallet: "AUTO", command: "./bot" }],
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /own-binary/);
});

test("a shared network, an open route out and bind-mount mode are each refused", () => {
  assert.match(posture({ env: {} }).join("\n"), /shared network.*unit-a, unit-b/);
  assert.match(
    posture({ env: { ERIS_AGENT_ISOLATE: "1" } }).join("\n"),
    /route out: unit-a, unit-b/,
  );
  assert.match(
    posture({ env: { ...isolated, ERIS_AGENT_BINDMOUNT: "1" } }).join("\n"),
    /bind-mount/,
  );
});

test("the network switches are read per roster entry, as the launcher reads them", () => {
  const reasons = posture({
    env: {},
    agents: [
      { id: "unit-a", wallet: "AUTO", env: isolated },
      { id: "unit-b", wallet: "AUTO" },
    ],
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /shared network.*: unit-b\./);
});

test("the runner tells the refusal from an epoch that failed", () => {
  assert.equal(isLiveWeekRefusal(new LiveWeekRefusal(["x"])), true);
  assert.equal(isLiveWeekRefusal(new Error("epoch failed")), false);
  assert.match(new LiveWeekRefusal(["x"]).message, /--scenario-key public/);
});

const USDC = {
  symbol: "USDC",
  address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address,
  decimals: 6,
};
const isAnvil0 = (address: Address): boolean =>
  address.toLowerCase() === ANVIL_0.toLowerCase();

test("anvil's public test accounts must be empty: their keys sign a transfer into any wallet", async () => {
  const read: string[] = [];
  const empty = await publicAccountRefusal(
    {
      eth: async (address) => {
        read.push(address.toLowerCase());
        return 0n;
      },
      erc20: async () => 0n,
    },
    [USDC],
  );
  assert.equal(empty, undefined);
  assert.deepEqual(new Set(read), publicTestAddresses());

  // What `--accounts 10 --balance 1000000` left on the backtest anvil, and what a dump deployed
  // from the default mnemonic carries in its state.
  const refusal = await publicAccountRefusal(
    { eth: async (a) => (isAnvil0(a) ? 10n ** 24n : 0n), erc20: async () => 0n },
    [USDC],
  );
  assert.ok(refusal);
  assert.match(refusal, new RegExp(ANVIL_0.toLowerCase()));
  assert.match(refusal, /1000000 ETH/);
  assert.match(refusal, /--accounts 0/);
});

test("tokens without ETH are refused too: the backtest chain runs at base fee 0", async () => {
  const refusal = await publicAccountRefusal(
    {
      eth: async () => 0n,
      erc20: async (token, a) => (token === USDC.address && isAnvil0(a) ? 25_000_000_000n : 0n),
    },
    [USDC],
  );
  assert.ok(refusal);
  assert.match(refusal, /25000 USDC/);
});

test("a state dump is refused by its manifest when it carries public accounts, or does not say", () => {
  assert.equal(stateDumpRefusal({ publicTestAccounts: [] }), undefined);
  assert.match(stateDumpRefusal({}) ?? "", /does not say/);
  const deployed = stateDumpRefusal({
    publicTestAccounts: [
      { address: ANVIL_0.toLowerCase(), balanceWei: (10n ** 21n).toString(), nonce: 412 },
    ],
  });
  assert.match(deployed ?? "", /default mnemonic/);
  assert.match(deployed ?? "", /1000 ETH/);
  assert.match(deployed ?? "", /MNEMONIC=/);
});

test("the dump measurement finds public accounts that hold ETH or signed, and nothing else", () => {
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const found = publicTestAccountsInDump({
    [ANVIL_0]: { balance: "0x3635c9adc5dea00000", nonce: "0x19c" },
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8": { balance: "0x0", nonce: "0" },
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC": { balance: "0xd3c21bcecceda1000000", nonce: 0 },
    [stranger]: { balance: "0xffff", nonce: "3" },
  });
  assert.deepEqual(found, [
    {
      address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
      balanceWei: (10n ** 24n).toString(),
      nonce: 0,
    },
    { address: ANVIL_0.toLowerCase(), balanceWei: (10n ** 21n).toString(), nonce: 412 },
  ]);
});
