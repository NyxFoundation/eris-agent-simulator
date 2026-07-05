// Minimal hardhat config that runs the @aave/deploy-v3 prebuilt artifacts + deploy
// scripts against a running anvil (localhost:8545).
require("hardhat-deploy");
require("@nomiclabs/hardhat-ethers");

const {
  DEFAULT_NAMED_ACCOUNTS,
} = require("@aave/deploy-v3/dist/helpers/constants");

module.exports = {
  solidity: {
    version: "0.8.10",
    settings: { optimizer: { enabled: true, runs: 100000 } },
  },
  networks: {
    // anvil. saveDeployments writes addresses out to deployments/localhost/*.json.
    localhost: {
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
      live: false,
      saveDeployments: true,
      // Use anvil's unlocked accounts (signing happens on the node side)
    },
  },
  namedAccounts: { ...DEFAULT_NAMED_ACCOUNTS },
  // Load prebuilt artifacts and deploy scripts from the external package (no recompile)
  external: {
    contracts: [
      {
        artifacts: "node_modules/@aave/deploy-v3/artifacts",
        deploy: "node_modules/@aave/deploy-v3/dist/deploy",
      },
    ],
  },
  mocha: { timeout: 0 },
};
