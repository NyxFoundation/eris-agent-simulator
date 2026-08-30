// Entry point for `npm run stress:rpc` (issue #36). The measurement lives in core/src/rpcStress.ts;
// this half exists only to set the env before any constants-dependent module loads -- the read set
// is built from the deployment's addresses, and those are chosen at import time (see bootstrapEnv).
import { bootstrapCliEnv } from "./bootstrapEnv.js";

bootstrapCliEnv();

const { runRpcStress } = await import("../rpcStress.js");

runRpcStress().catch((err: unknown) => {
  console.error(`[rpc-stress] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
