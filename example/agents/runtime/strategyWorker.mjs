// Node 22 does not natively load TypeScript worker entry points. Register the same loader used by
// bot.ts explicitly, so this also works in submitted bundles without a repository tsconfig.
import { register } from "tsx/esm/api";
register();
await import("./strategyWorker.ts");
