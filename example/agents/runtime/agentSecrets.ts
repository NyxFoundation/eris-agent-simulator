// How the agent process receives its credentials, and what is still exposed.
//
// A process's environment at exec stays readable for its whole life at /proc/<pid>/environ, by any
// process of the same uid -- including the child process a generated strategy runs in
// (strategyRunner.ts) -- and `delete process.env.X` does not change it: that file is the exec-time
// block, not the live map. So the coordinator does not put the wallet key, the inference token or
// any other credential (sdk/src/secretEnv.ts) in the agent's environment. It sets
// ERIS_AGENT_SECRETS=stdin and writes them as one JSON object to the agent's stdin
// (core/src/realtime/agentProcess.ts; infra/docker-agent/run-agent.sh passes stdin into the
// container). Read here, before the runtime loads, they go into process.env, where the runtime has
// always read them: names set after exec are not in the exec-time block.
//
// A self-hosted agent is started by hand (docs/guide/practice-devnet.md). It can name a file with
// ERIS_AGENT_PRIVATE_KEY_FILE instead of putting the key in its environment; the key in the
// environment still works, and isolationWarnings says what that leaves open.
import { readFileSync } from "node:fs";

export const AGENT_SECRETS_ENV = "ERIS_AGENT_SECRETS";
export const PRIVATE_KEY_FILE_ENV = "ERIS_AGENT_PRIVATE_KEY_FILE";

type Source = "stdin" | "file" | "env" | "none";
let keySource: Source = "none";

export function loadAgentSecrets(
  env: NodeJS.ProcessEnv = process.env,
  read: (pathOrFd: string | number) => string = (p) => readFileSync(p, "utf8"),
): Source {
  const channel = env[AGENT_SECRETS_ENV];
  const keyInEnv = env.ERIS_AGENT_PRIVATE_KEY !== undefined;
  if (channel !== undefined) {
    if (channel !== "stdin")
      throw new Error(`${AGENT_SECRETS_ENV} must be "stdin", not "${channel}"`);
    let secrets: unknown;
    try {
      secrets = JSON.parse(read(0));
    } catch (error) {
      throw new Error(
        `${AGENT_SECRETS_ENV}=stdin, but stdin did not hold a JSON object of credentials: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets))
      throw new Error(`${AGENT_SECRETS_ENV}=stdin, but stdin held no JSON object`);
    for (const [name, value] of Object.entries(secrets)) {
      if (typeof value !== "string")
        throw new Error(`credential ${name} on stdin is not a string`);
      env[name] = value;
    }
  }
  const file = env[PRIVATE_KEY_FILE_ENV];
  if (file !== undefined) {
    if (env.ERIS_AGENT_PRIVATE_KEY !== undefined)
      throw new Error(
        `both ERIS_AGENT_PRIVATE_KEY and ${PRIVATE_KEY_FILE_ENV} are set; set one`,
      );
    env.ERIS_AGENT_PRIVATE_KEY = read(file).trim();
  }
  keySource = keyInEnv
    ? "env"
    : channel !== undefined && env.ERIS_AGENT_PRIVATE_KEY !== undefined
      ? "stdin"
      : file !== undefined
        ? "file"
        : "none";
  return keySource;
}

// What a self-improving agent should hear at start, on the host it runs on. Only Linux exposes
// another process's environment and memory through /proc; elsewhere there is nothing to say.
//
// - The key in the environment: readable by the generated strategy's process at
//   /proc/<ppid>/environ, whatever the vm and the worker env do.
// - Yama's ptrace_scope at 0 (or no Yama): a process of the same uid may read this process's
//   memory, where the key is however it arrived. At 1, the default on Ubuntu, a descendant may not.
export function isolationWarnings(
  platform: NodeJS.Platform = process.platform,
  source: Source = keySource,
  readScope: () => string = () =>
    readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8"),
): string[] {
  if (platform !== "linux") return [];
  const warnings: string[] = [];
  if (source === "env")
    warnings.push(
      "the wallet key arrived in this process's environment, which the generated strategy's " +
        `process can read at /proc/<pid>/environ; pass it with ${PRIVATE_KEY_FILE_ENV} instead`,
    );
  let scope: string | undefined;
  try {
    scope = readScope().trim();
  } catch {
    scope = undefined;
  }
  if (scope === undefined || scope === "0")
    warnings.push(
      (scope === undefined
        ? "this kernel has no Yama ptrace_scope"
        : "kernel.yama.ptrace_scope is 0") +
        ": a process of the same user, the generated strategy's among them, may read this " +
        "process's memory and the wallet key in it (set it to 1)",
    );
  return warnings;
}
