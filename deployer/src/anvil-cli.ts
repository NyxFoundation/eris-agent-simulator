/**
 * `npm run anvil` — start anvil in the foreground with this package's calibration.
 *
 * A script rather than a literal command line in package.json so that the flags, and above all
 * `--mnemonic`, come from the same builder the in-process `startAnvil` uses. The npm script could
 * not read `deployer/.env` anyway (dotenv runs inside this package, not in npm), so an operator
 * who put a secret MNEMONIC there would have got a default-mnemonic chain from this entry point
 * and a secret-mnemonic deploy from the other one (issue #74).
 */
import { spawn } from "node:child_process";
import { anvilArgs } from "./anvil.js";
import { accounts } from "./clients.js";
import { MNEMONIC_IS_DEFAULT, RPC_PORT } from "./config.js";

console.log(
  `anvil :${RPC_PORT} — deployer ${accounts.deployer.address} ` +
    `(${MNEMONIC_IS_DEFAULT ? "anvil's public test mnemonic" : "MNEMONIC from the environment"})`,
);

const proc = spawn("anvil", anvilArgs(), { stdio: "inherit" });
proc.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => proc.kill(sig));
}
