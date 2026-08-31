// Entry point for `npm run manifest` (ADR 0021 §2). The env prelude has to run before anything
// imports the address registry, since the local-deploy overlay is chosen at import time.
import { bootstrapCliEnv } from "./bootstrapEnv.js";

bootstrapCliEnv();

const { runManifestCli } = await import("../manifestCli.js");
runManifestCli();
