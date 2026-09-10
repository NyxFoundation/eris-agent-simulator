/**
 * The deploy keys are configurable (issue #74).
 *
 * A production chain that anyone may send transactions to cannot run on anvil's public test
 * mnemonic: those words are printed in the node's banner, so every privileged role the deploy hands
 * to account index 0 -- Aave's POOL_ADMIN, GMX's CONFIG_KEEPER, the owner of every seeded LP
 * position -- is held by a key the participants already have. These tests pin the two halves of
 * making that configurable: that nothing here assumes Hardhat's account 0, and that anvil is
 * actually told which mnemonic to use.
 *
 * Pure: no chain, no network. Run with `npm run test:unit`.
 */
import { describe, it, expect } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { anvilArgs } from "../../src/anvil.js";
import {
  ACCOUNT_INDEX,
  DEFAULT_MNEMONIC,
  normalizeMnemonic,
} from "../../src/config.js";

// A throwaway mnemonic, valid BIP-39 and public on purpose: a test fixture must never be a
// mnemonic anyone could mistake for a real one. It exists to be *different* from the default.
const ALT_MNEMONIC =
  "script bracket want ahead motor sail coyote name lottery want gold amused";

const HARDHAT_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("mnemonic handling", () => {
  it("derives Hardhat's well-known account 0 from the default mnemonic", () => {
    // The default has to keep working: every local flow, the CI deploy job and the poc's
    // constants.local.ts are written against these addresses.
    const account = mnemonicToAccount(DEFAULT_MNEMONIC, {
      addressIndex: ACCOUNT_INDEX.deployer,
    });
    expect(account.address).toBe(HARDHAT_ACCOUNT_0);
  });

  it("derives a different account for every role from a non-default mnemonic", () => {
    for (const index of Object.values(ACCOUNT_INDEX)) {
      const mine = mnemonicToAccount(ALT_MNEMONIC, { addressIndex: index });
      const theirs = mnemonicToAccount(DEFAULT_MNEMONIC, {
        addressIndex: index,
      });
      expect(mine.address).not.toBe(theirs.address);
    }
    expect(
      mnemonicToAccount(ALT_MNEMONIC, { addressIndex: ACCOUNT_INDEX.deployer })
        .address,
    ).not.toBe(HARDHAT_ACCOUNT_0);
  });

  it("normalizes the whitespace a mnemonic arrives with", () => {
    // `MNEMONIC="$(cat ~/.secret-mnemonic)"` keeps no newline, but a file read by other means, or a
    // paste out of a password manager, does -- and BIP-39 would reject words that read as correct.
    expect(normalizeMnemonic(`  ${DEFAULT_MNEMONIC}\n`)).toBe(DEFAULT_MNEMONIC);
    expect(normalizeMnemonic(DEFAULT_MNEMONIC.replace(/ /g, "  "))).toBe(
      DEFAULT_MNEMONIC,
    );
  });

  it("rejects a mnemonic that is not valid BIP-39, before anything is deployed", () => {
    // One wrong word fails the checksum. Caught on the words rather than on the first signature,
    // where the deploy has already started anvil and written half a registry.
    expect(() =>
      normalizeMnemonic(DEFAULT_MNEMONIC.replace("junk", "banana")),
    ).toThrow(/BIP-39/);
    expect(() => normalizeMnemonic("")).toThrow(/BIP-39/);
  });
});

describe("anvilArgs", () => {
  it("tells anvil which mnemonic to use", () => {
    const args = anvilArgs({ mnemonic: ALT_MNEMONIC });
    const at = args.indexOf("--mnemonic");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe(ALT_MNEMONIC);
  });

  it("passes the flag even for the default mnemonic", () => {
    // Passing it always is what keeps the two entry points (this builder, and `npm run anvil`,
    // which uses it) from diverging into two chains with two sets of keys.
    const args = anvilArgs({ mnemonic: DEFAULT_MNEMONIC });
    expect(args[args.indexOf("--mnemonic") + 1]).toBe(DEFAULT_MNEMONIC);
  });

  it("keeps the calibration the venues need", () => {
    // Uniswap V3 does not fit under the default code size limit, and GMX does not fit under the
    // default gas limit; the state-dump replay anvil is calibrated to match (ADR 0016).
    const args = anvilArgs({ port: 8547 });
    expect(args.join(" ")).toContain("--code-size-limit 50000");
    expect(args.join(" ")).toContain("--base-fee 0");
    expect(args.join(" ")).toContain("--gas-limit 3000000000");
    expect(args[args.indexOf("--port") + 1]).toBe("8547");
  });
});
