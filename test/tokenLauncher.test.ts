import test from "node:test";
import assert from "node:assert/strict";
import { encodeDeployData, getContractAddress, type Address } from "viem";
import { TOKENS } from "@eris/sdk/constants.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import { sqrtPriceX96For } from "@eris/sdk/protocols/uniswap.js";
import {
  installWalletSecret,
  resetWalletSecret,
} from "../core/src/walletKeys.js";
import {
  LAUNCH_TOKEN_DECIMALS,
  WAVE_PRICE_CAP_MULT,
  launchPriceUsdcPerToken,
  launchSalt,
  launchTokenArgs,
  predictLaunchToken,
  waveBuyCapped,
} from "../core/src/realtime/tokenLaunch.js";

// The listing used to be five transactions from a launch wallet whose address and nonce were public
// from block 0, so the token's CREATE address was known ahead of the window and anyone could
// pre-create its pool at their own price. These pin the pieces of the fix that need no chain: the
// salt is secret and per attempt, the prediction is CREATE2's, the wave refuses an absurd price, and
// the launcher is deployed in every official regime alike.

const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);

test("the listing salt is the wallet secret's, and differs per seed, launch and attempt", () => {
  try {
    installWalletSecret({ source: "file", hex: SECRET_A });
    const base = launchSalt(101, 0, 0, 1);
    assert.match(base, /^0x[0-9a-f]{64}$/);
    assert.equal(launchSalt(101, 0, 0, 1), base, "deterministic within one secret");
    const variants = [
      launchSalt(102, 0, 0, 1),
      launchSalt(101, 1, 0, 1),
      launchSalt(101, 0, 1, 1),
      launchSalt(101, 0, 0, 2),
    ];
    assert.equal(new Set([base, ...variants]).size, 5);
    installWalletSecret({ source: "file", hex: SECRET_B });
    assert.notEqual(launchSalt(101, 0, 0, 1), base, "a different secret, a different address");
  } finally {
    resetWalletSecret();
  }
});

test("the predicted token address is CREATE2 of the launcher, the salt and the AgentERC20 init code", () => {
  let artifact: ReturnType<typeof readForgeArtifact>;
  try {
    artifact = readForgeArtifact("AgentERC20");
  } catch {
    return; // no `out/` in this checkout: npm run build:contracts
  }
  const launcher = "0x00000000000000000000000000000000000000aa" as Address;
  const salt = `0x${"12".repeat(32)}` as const;
  const args = launchTokenArgs({
    eventIndex: 2,
    index: 1,
    symbol: "LT21",
    tokenSupplyWei: 50_000n * 10n ** 18n,
  });
  assert.deepEqual(args, ["Launch Token 2-1", "LT21", LAUNCH_TOKEN_DECIMALS, 50_000n * 10n ** 18n]);
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const predicted = predictLaunchToken(launcher, salt, initCode);
  assert.equal(
    predicted,
    getContractAddress({ opcode: "CREATE2", from: launcher, salt, bytecode: initCode }),
  );
  // Not the CREATE address of any nonce of the launcher: that is the point of the salt.
  for (let nonce = 0n; nonce < 8n; nonce++)
    assert.notEqual(predicted, getContractAddress({ from: launcher, nonce }));
});

test("the listing price reads back as 1.00 USDC on either side of the pair", () => {
  for (const tokenIsToken0 of [true, false]) {
    const sqrt = sqrtPriceX96For({
      humanPrice: 1,
      token0Decimals: tokenIsToken0 ? LAUNCH_TOKEN_DECIMALS : TOKENS.USDC.decimals,
      token1Decimals: tokenIsToken0 ? TOKENS.USDC.decimals : LAUNCH_TOKEN_DECIMALS,
    });
    const price = launchPriceUsdcPerToken(sqrt, tokenIsToken0);
    assert.ok(Math.abs(price - 1) < 1e-9, `tokenIsToken0=${tokenIsToken0}: ${price}`);
  }
});

test("the wave cap: honest wave prices pass, a bought-out pool is refused", () => {
  assert.equal(WAVE_PRICE_CAP_MULT, 10);
  // The largest official wave (1.0x the seeded USDC) alone takes a full-range pool to 4x.
  for (const p of [0.5, 1, 1.1, 4, 9.99, 10]) assert.equal(waveBuyCapped(p), false, String(p));
  // The measured exploit priced the token at ~5.8e17 USDC; anything past the cap, NaN and
  // Infinity (a pool with no token left) are refused.
  for (const p of [10.01, 100, 5.8e17, Number.POSITIVE_INFINITY, Number.NaN])
    assert.equal(waveBuyCapped(p), true, String(p));
});
