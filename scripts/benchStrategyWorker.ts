// Reproducible local overhead measurement for issue #86; no RPC or full simulation is needed.
// node --import tsx scripts/benchStrategyWorker.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@eris/sdk/config.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import { StrategyRunner } from "../example/agents/runtime/strategyRunner.js";

const dir = mkdtempSync(join(tmpdir(), "eris-worker-bench-"));
const path = join(dir, "agent.ts");
writeFileSync(
  path,
  `export function decide(obs) {
  if (obs.round === -1) return { type: 'noop', heap: process.memoryUsage().heapUsed };
  if (obs.round === -2) { while (true) {} }
  let total = 0; for (const sample of obs.samples) total += sample.value;
  return { type: 'noop', total };
}`,
);
const { decide } = await import(pathToFileURL(path).href);
const observation = {
  round: 1,
  samples: Array.from({ length: 512 }, (_, i) => ({
    value: i / 100,
    address: `0x${i.toString(16).padStart(40, "0")}`,
    balance: "1234567890123456789",
    price: 2500.125,
  })),
} as unknown as AgentObservation;
const context = {
  agentId: "bench",
  address: "0x0000000000000000000000000000000000000001" as const,
  rpcUrl: "http://127.0.0.1:1",
  config: loadConfig(),
};
const summarize = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.floor(values.length * 0.95)],
  };
};
async function measure(fn: () => unknown | Promise<unknown>, n = 1000) {
  for (let i = 0; i < 50; i++) await fn();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}
const runner = new StrategyRunner(
  { kind: "module", path },
  context,
  () => {},
  100,
);
try {
  const direct = await measure(() => decide(observation));
  const clone = await measure(() => structuredClone(observation));
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  await runner.start();
  const startupMs = performance.now() - started;
  const worker = await measure(() => runner.decide(observation));
  const workerHeap = (await runner.decide({ round: -1 } as AgentObservation))
    .action as { heap: number };
  const rssWithWorker = process.memoryUsage().rss;
  const respawns = [];
  for (let i = 0; i < 5; i++) {
    try {
      await runner.decide({ round: -2 } as AgentObservation);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("decide timeout:"))
        throw e;
    }
    const began = performance.now();
    await runner.decide(observation);
    respawns.push(performance.now() - began);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        observationBytes: Buffer.byteLength(JSON.stringify(observation)),
        samples: 1000,
        direct,
        clone,
        worker,
        startupMs,
        respawn: summarize(respawns),
        rssBeforeMiB: rssBefore / 2 ** 20,
        rssWithWorkerMiB: rssWithWorker / 2 ** 20,
        rssDeltaMiB: (rssWithWorker - rssBefore) / 2 ** 20,
        workerHeapMiB: workerHeap.heap / 2 ** 20,
      },
      null,
      2,
    ),
  );
} finally {
  await runner.close();
  rmSync(dir, { recursive: true, force: true });
}
