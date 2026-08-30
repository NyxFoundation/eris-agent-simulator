// Local deploy: `sdk/src/constants.ts` reads `process.env.ERIS_LOCAL_DEPLOY` **at import time**
// and overlays LOCAL_DEPLOYMENT (local addresses for WETH/USDC/WBTC, etc.). So for config
// `run.localDeploy: true` / CLI `--local-deploy` to take effect, the env must be set **before**
// loading the coordinator (or runConfig -> markets -> constants) that indirectly imports constants.
// bootstrapCliEnv peeks at the config/CLI with just yaml + fs (importing no constants-dependent
// module) to set it; the coordinator is then imported dynamically.
import { bootstrapCliEnv } from "./bootstrapEnv.js";

bootstrapCliEnv();

// Evaluate constants-dependent modules only after the env is set (dynamically, since static imports are hoisted).
const { runRealtimeSimulation } = await import("../realtime/coordinator.js");

runRealtimeSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
