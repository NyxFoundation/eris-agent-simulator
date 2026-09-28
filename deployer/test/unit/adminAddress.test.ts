/**
 * The venue operators follow the runs' admin key.
 *
 * The Liquity oracle adapter (immutable operator) and the LST vault are operated by the address of
 * the poc's ADMIN_PRIVATE_KEY. It used to be fixed to the default admin, `keccak256("eris-role:admin")`,
 * so a chain deployed on a secret mnemonic still gave both to a key anyone can compute -- and a run
 * with its own admin key refused to start, because the deployed operator cannot be changed.
 *
 * Pure: no chain, no network. Run with `npm run test:unit`.
 */
import { describe, it, expect } from "vitest";
import { getAddress, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_ADMIN_ADDRESS, resolveAdminAddress } from "../../src/config.js";

// Public on purpose: a fixture, not anyone's admin.
const OTHER = "0x00000000000000000000000000000000000a0001";

describe("admin address", () => {
  it("defaults to the poc's default admin key on the public mnemonic", () => {
    expect(DEFAULT_ADMIN_ADDRESS).toBe(
      privateKeyToAccount(keccak256(toBytes("eris-role:admin"))).address,
    );
    expect(resolveAdminAddress(undefined, true)).toBe(DEFAULT_ADMIN_ADDRESS);
  });

  it("takes ADMIN_ADDRESS, checksummed, whatever the mnemonic", () => {
    expect(resolveAdminAddress(OTHER, true)).toBe(getAddress(OTHER));
    expect(resolveAdminAddress(` ${OTHER}\n`, false)).toBe(getAddress(OTHER));
  });

  it("refuses a secret mnemonic without ADMIN_ADDRESS, before anything is deployed", () => {
    expect(() => resolveAdminAddress(undefined, false)).toThrow(
      /ADMIN_ADDRESS is unset/,
    );
    expect(() => resolveAdminAddress("", false)).toThrow(
      /ADMIN_ADDRESS is unset/,
    );
  });

  it("keeps the default on a secret mnemonic only when told to", () => {
    expect(resolveAdminAddress("default", false)).toBe(DEFAULT_ADMIN_ADDRESS);
  });

  it("refuses something that is not an address", () => {
    expect(() => resolveAdminAddress("0x1234", false)).toThrow(
      /not an address/,
    );
  });
});
