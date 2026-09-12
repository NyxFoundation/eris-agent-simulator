/**
 * The two hardhat-deploy subprojects sign with the same mnemonic as everything else (issue #74).
 *
 * Aave and GMX are the only venues deployed by a child process rather than by viem in this one, and
 * hardhat's default for an http network is `accounts: "remote"` -- sign on the node, as whatever
 * the node has unlocked. That silently makes the deployer whoever *anvil's* mnemonic derives, so a
 * secret MNEMONIC would reach five venues and miss these two: their roles (Aave's aclAdmin /
 * poolAdmin, GMX's CONFIG_KEEPER and MARKET_KEEPER, both resolved from account *index* 0) would
 * stay with anvil's published test keys.
 *
 * Checked as text because neither config is loadable from here: both need their own node_modules
 * (`vendor/gmx-src` is not even tracked -- setup-vendors.sh clones it), and requiring hardhat to
 * answer a question about one line of configuration would make this an integration test.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { ROOT } from "../../src/util.js";
import { DEFAULT_MNEMONIC } from "../../src/config.js";

// `mnemonic: process.env.MNEMONIC || "<fallback>"` in whatever formatting prettier chose.
const WIRING = /mnemonic:\s*\n?\s*process\.env\.MNEMONIC\s*\|\|\s*\n?\s*"([^"]+)"/;

function expectMnemonicWiring(source: string, what: string) {
  const match = source.match(WIRING);
  expect(
    match,
    `${what} does not derive its accounts from process.env.MNEMONIC`,
  ).not.toBeNull();
  // The fallback has to be the same default, or an unset MNEMONIC would deploy this venue to a
  // different owner than the rest -- the exact failure the wiring exists to prevent, inverted.
  expect(match![1]).toBe(DEFAULT_MNEMONIC);
}

describe("hardhat subprojects", () => {
  it("wires Aave's localhost network to MNEMONIC", () => {
    expectMnemonicWiring(
      readFileSync(resolve(ROOT, "vendor", "aave", "hardhat.config.js"), "utf8"),
      "vendor/aave/hardhat.config.js",
    );
  });

  it("wires GMX's localhost network to MNEMONIC", () => {
    // The applied vendor tree when it is present (that is what actually runs), the patch that
    // produces it otherwise -- a fresh checkout has no clone, and CI still gets the check.
    const applied = resolve(ROOT, "vendor", "gmx-src", "hardhat.config.ts");
    if (existsSync(applied)) {
      expectMnemonicWiring(readFileSync(applied, "utf8"), applied);
      return;
    }
    const patch = readFileSync(
      resolve(ROOT, "vendor", "gmx-localhost.patch"),
      "utf8",
    );
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .join("\n");
    expectMnemonicWiring(added, "vendor/gmx-localhost.patch");
  });
});

describe("npm run anvil", () => {
  it("goes through the arg builder rather than spelling out a command line", () => {
    // A literal `anvil --port ...` in package.json cannot read deployer/.env (dotenv runs inside
    // this package, not in npm), so an operator with a secret MNEMONIC there would have started a
    // default-mnemonic chain from this entry point and deployed a secret-mnemonic one from the
    // other. The two have to come from one place.
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.anvil).toContain("src/anvil-cli.ts");
    expect(pkg.scripts.anvil.startsWith("anvil ")).toBe(false);
  });
});
