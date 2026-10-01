// Close Aave's own test market on a chain that is already running (issue #190).
//
// A fresh deploy does this itself (deployAaveV3 -> closeVendorTestMarket). This is for a chain
// deployed before that, which cannot simply be redeployed -- the practice devnet keeps its state for
// the whole period. Same function, same key: the deployer (index 0 of MNEMONIC) owns the Faucet and
// is POOL_ADMIN. Points at RPC_URL and reads deployments.json + vendor/aave/deployments like deploy.
//
//   cd deployer && RPC_URL=http://<node>:8545 npm run close:aave-vendor
//
// Exits 2 when a reserve could only be frozen: it already holds supply or debt, which keeps counting.
import { closeVendorTestMarket } from "./protocols/aave-v3.js";

const outcomes = await closeVendorTestMarket();
console.log(JSON.stringify(outcomes, null, 2));
process.exit(outcomes.some((o) => o.status === "frozen") ? 2 : 0);
