import { spawn } from "node:child_process";

// In local (non-fork) deploy mode, poc does not start anvil. It reuses the anvil that the
// bundled deployer/ has deployed all protocols on (start that anvil with `npm run deploy`,
// and connect poc to it with ERIS_LOCAL_DEPLOY=1).
if (process.env.ERIS_LOCAL_DEPLOY === "1") {
  console.error(
    "ERIS_LOCAL_DEPLOY=1: poc's own anvil is not needed.\n" +
      "  Run `npm run deploy` in the bundled deployer/ (starts anvil + deploys all protocols),\n" +
      "  then start poc against that anvil (127.0.0.1:8545) with ERIS_LOCAL_DEPLOY=1.",
  );
  process.exit(1);
}

const required = ["ARB_RPC_URL"] as const;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const args = [
  "--fork-url",
  process.env.ARB_RPC_URL!,
  "--no-mining",
  "--order",
  "fees",
  "--auto-impersonate",
  "--port",
  process.env.ANVIL_PORT ?? "8545",
  "--chain-id",
  process.env.CHAIN_ID ?? "42161",
  "--block-base-fee-per-gas",
  process.env.BASE_FEE_WEI ?? "100000000",
];

if (process.env.FORK_BLOCK_NUMBER) {
  args.splice(2, 0, "--fork-block-number", process.env.FORK_BLOCK_NUMBER);
}

// Cut the retry wait on eth_getAccountInfo failures (unsupported on Alchemy Arbitrum). The default
// 1000ms backoff accumulates on every cold state fetch and inflates oracleMs, so use 0 to fall back immediately.
if (process.env.FORK_RETRY_BACKOFF !== undefined) {
  args.push("--fork-retry-backoff", process.env.FORK_RETRY_BACKOFF);
}
// Don't get capped by Alchemy shared-plan rate limits (estimated CUPS).
if (process.env.ANVIL_NO_RATE_LIMIT === "1") {
  args.push("--no-rate-limit");
}

const child = spawn("anvil", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
