// What a strategy's process.env holds (issue #215).
//
// A hand-written decide() strategy runs in a worker thread, a generated one in a child process
// (strategyRunner.ts), and a Python one in a child process too (pyBridge.ts). None signs anything
// -- the parent does, in send.ts -- and none talks to a model: the revision loop is the parent's
// too. So the wallet key, the inference token
// and every API key are secrets those processes have no use for, and until now they inherited all
// of them with the parent's whole environment. For a generated strategy that is the difference
// between a vm escape that finds `process.env` and one that finds nothing in it; for a hand-written
// one it is the difference between an accidental `ctx.log({ state: process.env })` that leaks the
// wallet and one that does not.
//
// Which names are credentials is sdk/src/secretEnv.ts, shared with the coordinator.

import { isSecretEnvName } from "@eris/sdk/secretEnv.js";

export const isStrategySecretEnv = isSecretEnvName;

// The environment a strategy process gets: the parent's, less every name secretEnv.ts calls a
// credential. Undefined values
// are dropped as well, so the result can be handed to a Worker or a spawn as it is.
export function strategyEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isStrategySecretEnv(name)) continue;
    out[name] = value;
  }
  return out;
}
