import test from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { AgentObservation, RegistryEntryObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import { launchPools } from "../example/agents/lib/launchSwap.js";

// Issue #216 (4). The registry publishes a participant's USDC pool exactly as it publishes the
// environment's launch; the reference agents must trade only what looks like a launch. These pin
// the shape filter (the token's own entry, deployed by the pool's creator, code unchanged) and the
// codehash leg on synthetic registry entries, with no chain.

const USDC = TOKENS.USDC.address;
const LAUNCH_WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ME = "0x3333333333333333333333333333333333333333";
const ENV_CODEHASH = `0x${"e".repeat(64)}` as Hex;
const OTHER_CODEHASH = `0x${"f".repeat(64)}` as Hex;

let n = 0;
const addr = () => `0x${(++n).toString(16).padStart(40, "a")}`;

type Listing = {
  pool: string;
  token: string;
  poolCreator?: string;
  tokenCreator?: string | null; // null = no erc20 entry published (yet)
  codehash?: string;
  codehashNow?: string;
  block?: number;
  mine?: boolean;
  tokenIsToken0?: boolean;
};

function entries(listings: Listing[]): RegistryEntryObservation[] {
  const out: RegistryEntryObservation[] = [];
  for (const l of listings) {
    const creator = l.poolCreator ?? LAUNCH_WALLET;
    const [token0, token1] = l.tokenIsToken0 ? [l.token, USDC] : [USDC, l.token];
    out.push({
      market: l.pool,
      kind: "uniswapV3Pool",
      creator,
      mine: l.mine ?? false,
      token0,
      token1,
      codehashAtRegistration: `0x${"9".repeat(64)}`,
      verified: true,
      registeredAtBlock: String(l.block ?? 100),
    });
    if (l.tokenCreator === null) continue;
    out.push({
      market: l.token,
      kind: "erc20",
      creator: l.tokenCreator ?? creator,
      mine: false,
      codehashAtRegistration: l.codehash ?? ENV_CODEHASH,
      ...(l.codehashNow ? { codehashNow: l.codehashNow } : {}),
      verified: false,
      registeredAtBlock: String(l.block ?? 100),
    });
  }
  return out;
}

function obs(listings: Listing[]): AgentObservation {
  return {
    registry: { address: addr(), entries: entries(listings), allowances: [] },
  } as unknown as AgentObservation;
}

test("an environment-shaped listing is a launch pool, with or without the codehash leg", () => {
  const pool = addr();
  const token = addr();
  const o = obs([{ pool, token, block: 120 }]);
  for (const filter of [{}, { tokenCodehash: ENV_CODEHASH }, { tokenCodehash: null }]) {
    const found = launchPools(o, filter);
    assert.equal(found.length, 1, JSON.stringify(filter));
    assert.equal(found[0].pool, pool);
    assert.equal(found[0].token, token);
    assert.equal(found[0].tokenIsToken0, false);
    assert.equal(found[0].creator, LAUNCH_WALLET);
    assert.equal(found[0].registeredAtBlock, 120);
    assert.equal(found[0].tokenCodehash, ENV_CODEHASH);
  }
  const flipped = launchPools(obs([{ pool, token, tokenIsToken0: true }]));
  assert.equal(flipped[0]?.tokenIsToken0, true);
});

test("a pool whose creator did not deploy the token is not a launch", () => {
  const o = obs([{ pool: addr(), token: addr(), poolCreator: OTHER, tokenCreator: LAUNCH_WALLET }]);
  assert.deepEqual(launchPools(o), []);
  // The registry writes addresses in whatever case it got; the comparison does not care.
  const upper = obs([{ pool: addr(), token: addr(), poolCreator: LAUNCH_WALLET.toUpperCase().replace("0X", "0x"), tokenCreator: LAUNCH_WALLET }]);
  assert.equal(launchPools(upper).length, 1);
});

test("a pool whose token has no entry yet is not a launch yet", () => {
  const token = addr();
  const o = obs([{ pool: addr(), token, tokenCreator: null }]);
  assert.deepEqual(launchPools(o), []);
});

test("the codehash leg keeps out a token with other code, and only when the hash is known", () => {
  const foreign = { pool: addr(), token: addr(), codehash: OTHER_CODEHASH, block: 101 };
  const env = { pool: addr(), token: addr(), block: 102 };
  const o = obs([foreign, env]);
  assert.deepEqual(
    launchPools(o, { tokenCodehash: ENV_CODEHASH }).map((p) => p.pool),
    [env.pool],
  );
  // Case-insensitive, like every other hash comparison here.
  assert.equal(launchPools(o, { tokenCodehash: ENV_CODEHASH.toUpperCase().replace("0X", "0x") as Hex }).length, 1);
  // Without the expected hash (no artifact, no node) the shape alone decides, and both pass.
  assert.deepEqual(
    launchPools(o, { tokenCodehash: null }).map((p) => p.pool),
    [foreign.pool, env.pool],
  );
});

test("a token whose code moved since registration is not a launch", () => {
  const o = obs([{ pool: addr(), token: addr(), codehashNow: OTHER_CODEHASH }]);
  assert.deepEqual(launchPools(o), []);
  const same = obs([{ pool: addr(), token: addr(), codehashNow: ENV_CODEHASH }]);
  assert.equal(launchPools(same).length, 1);
});

test("pools between priced tokens, and entries of other kinds, are ignored", () => {
  const pool = addr();
  const o = obs([{ pool, token: TOKENS.WETH.address }]);
  assert.deepEqual(launchPools(o), []);
  const noTokens = {
    registry: {
      address: addr(),
      entries: [
        { market: addr(), kind: "uniswapV3Pool", creator: LAUNCH_WALLET, mine: false, codehashAtRegistration: ENV_CODEHASH, verified: true, registeredAtBlock: "1" },
        { market: addr(), kind: "erc20", creator: LAUNCH_WALLET, mine: false, codehashAtRegistration: ENV_CODEHASH, verified: false, registeredAtBlock: "1" },
      ],
      allowances: [],
    },
  } as unknown as AgentObservation;
  assert.deepEqual(launchPools(noTokens), []);
  assert.deepEqual(launchPools({} as AgentObservation), []);
});

test("oldest first, and the agent's own listing is marked rather than hidden", () => {
  const late = { pool: addr(), token: addr(), block: 300 };
  const early = { pool: addr(), token: addr(), block: 200 };
  const own = { pool: addr(), token: addr(), block: 250, poolCreator: ME, tokenCreator: ME, mine: true };
  const found = launchPools(obs([late, early, own]));
  assert.deepEqual(found.map((p) => [p.pool, p.mine]), [[early.pool, false], [own.pool, true], [late.pool, false]]);
});
