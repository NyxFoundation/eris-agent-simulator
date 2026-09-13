// Run the same coordinator/container path as production, then report the exact returned run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { loadEnvLocal } from "../core/src/cli/bootstrapEnv.js";

const summarySchema = z.object({
  blocksProcessed: z.number().int().positive(),
  agents: z.array(z.object({
    id: z.string(),
    processExitedEarly: z.union([z.string(), z.literal(false)]).optional(),
    includedTxCount: z.number().int().nonnegative(),
    revertCount: z.number().int().nonnegative(),
    stderrTail: z.string(),
  })),
});

export function selftestVerdict(summary: unknown, id: string, memory: string): {
  passed: boolean;
  message: string;
} {
  const parsed = summarySchema.safeParse(summary);
  if (!parsed.success)
    return { passed: false, message: `FAIL ${id}: invalid or incomplete summary.json: ${parsed.error.message}` };
  const matches = parsed.data.agents.filter(agent => agent.id === id);
  if (matches.length !== 1)
    return { passed: false, message: `FAIL ${id}: expected one agent record, found ${matches.length}` };
  const agent = matches[0];
  if (agent.processExitedEarly !== undefined && agent.processExitedEarly !== false) {
    const oom = /(?:code|exit)\s+137\b|SIGKILL/.test(agent.processExitedEarly)
      ? ` (SIGKILL; possible OOM at memory cap ${memory})` : "";
    return {
      passed: false,
      message: `FAIL ${id}: ${agent.processExitedEarly}${oom}\n${agent.stderrTail}`.trimEnd(),
    };
  }
  return {
    passed: true,
    message: `PASS ${id}: completed the self-test at memory cap ${memory}; ` +
      `${agent.includedTxCount} included transactions, ${agent.revertCount} reverted. ` +
      `This verifies this run, not peak memory or every scenario.`,
  };
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || id === "noop" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) ||
      !existsSync(join("example/agents", id)))
    throw new Error("usage: agent:selftest -- <agent-id> (an agent directory other than noop)");
  loadEnvLocal();
  const memory = process.env.ERIS_DOCKER_MEM ?? "4g";
  const rpc = process.env.ERIS_RPC_URL ?? "http://127.0.0.1:8545";
  try {
    const response = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const block = await response.json() as { result?: unknown; error?: unknown };
    if (!response.ok || typeof block.result !== "string" || !/^0x[0-9a-f]+$/i.test(block.result) || block.error)
      throw new Error("invalid eth_blockNumber response");
  } catch (error) {
    throw new Error(
      `no working chain at ${rpc}; start cd deployer && npm run deploy -- --keep-fresh, ` +
      `then npm run gen:local-constants (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  console.log(`[1/3] build images eris-agent:${id} and eris-agent:noop`);
  for (const team of [id, "noop"])
    execFileSync("bash", ["infra/docker-agent/build.sh", "team", team], { stdio: "inherit" });
  const basePath = process.env.ERIS_SELFTEST_CONFIG ??
    (existsSync("config/local.yaml") ? "config/local.yaml" : "config/example.yaml");
  const config = parse(readFileSync(basePath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`invalid self-test config: ${basePath}`);
  config.run = { ...config.run, localDeploy: true, agentSandbox: "docker", segmentHours: 0 };
  delete config.run.agentsConfig;
  delete config.AGENTS_CONFIG;
  config.agents = [
    { id: "noop", wallet: "AUTO", baseline: true },
    { id, dir: id, wallet: "AUTO" },
  ];
  const tempDir = mkdtempSync(resolve("config/_selftest-"));
  const configPath = join(tempDir, "run.yaml");
  try {
    writeFileSync(configPath, stringify(config));
    console.log(`[2/3] run with memory cap ${memory}; config ${basePath}`);
    // Constants read local-deploy mode at import time, so select it before importing the coordinator.
    process.env.ERIS_LOCAL_DEPLOY = "1";
    process.env.ERIS_RPC_URL = rpc;
    process.env.ERIS_DOCKER_MEM = memory;
    const argv = [process.execPath, process.argv[1], "--config", configPath];
    const { runRealtimeSimulation } = await import("../core/src/realtime/coordinator.js");
    const { runDir } = await runRealtimeSimulation({ ANVIL_RPC_URL: rpc }, argv);
    const summaryPath = join(runDir, "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const verdict = selftestVerdict(summary, id, memory);
    const baseline = selftestVerdict(summary, "noop", memory);
    const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `name=^eris-(${id}|noop)$`], {
      encoding: "utf8", timeout: 5000,
    }).trim();
    if (remaining)
      throw new Error(`a self-test container survived; run infra/docker-agent/reap.sh`);
    if (!baseline.passed) throw new Error(`baseline: ${baseline.message}`);
    console.log(`[3/3] ${verdict.message}\nReport: ${summaryPath}`);
    if (!verdict.passed) process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`FAIL self-test: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
