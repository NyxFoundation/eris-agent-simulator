// Write the summary.json a practice segment did not get because its coordinator died mid-day
// (core/src/segmentRecovery.ts), and close the segment's entry in the period's matrix.json.
//
//   npm run close:crashed-segment -- runs/<period> <segment-dir> [--write]
//
// Without --write it prints what it would write. It refuses a segment that already has a summary,
// a period whose coordinator is still writing it (current-segment points at this segment and its
// events.jsonl moved in the last 10 minutes), and a segment with no previous summary to carry
// boundary 0 from.
import {
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  closeCrashedSegment,
  type BoundaryLine,
} from "../core/src/segmentRecovery.js";
import type { SegmentAgentIdentity } from "../core/src/segments.js";

type Json = Record<string, any>;

async function lines(file: string, each: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) each(line);
}

async function main(): Promise<void> {
  const [periodDir, segmentDir, ...rest] = process.argv.slice(2);
  const write = rest.includes("--write");
  if (!periodDir || !segmentDir)
    throw new Error("usage: close:crashed-segment -- runs/<period> <segment-dir> [--write]");
  const periodId = basename(periodDir);
  const dir = join(periodDir, segmentDir);
  const matrixPath = join(periodDir, "matrix.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Json;
  const scenarios = matrix.scenarios as Json[];
  const at = scenarios.findIndex((s) => String(s.runDir).endsWith(`/${segmentDir}`));
  if (at < 0) throw new Error(`${segmentDir} is not in ${matrixPath}`);
  if (existsSync(join(dir, "summary.json")))
    throw new Error(`${dir} already has a summary.json: the roll closed it`);
  const pointer = join(periodDir, "current-segment");
  const eventsPath = join(dir, "events.jsonl");
  if (
    existsSync(pointer) &&
    readFileSync(pointer, "utf8").trim().endsWith(segmentDir) &&
    Date.now() - statSync(eventsPath).mtimeMs < 10 * 60_000
  )
    throw new Error(`${dir} is still being written: its coordinator is running`);
  if (at === 0) throw new Error(`${segmentDir} is the period's first segment: no boundary 0 to carry`);
  const prevDir = join(periodDir, basename(String(scenarios[at - 1].runDir)));
  const prev = JSON.parse(readFileSync(join(prevDir, "summary.json"), "utf8")) as Json;
  const prevSeries = (prev.valueSeries?.intervalSeries ?? prev.valueSeries?.epochSeries) as Json;
  if (!prevSeries) throw new Error(`${prevDir}/summary.json has no boundary series`);

  const boundaryFile = existsSync(join(dir, "intervals.jsonl")) ? "intervals.jsonl" : "epochs.jsonl";
  const boundaryLines: BoundaryLine[] = [];
  await lines(join(dir, boundaryFile), (l) => boundaryLines.push(JSON.parse(l) as BoundaryLine));
  const toBlock = boundaryLines[boundaryLines.length - 1]?.blockNumber ?? Number(scenarios[at].fromBlock);

  // Who the coordinator knew: everyone in the previous summary, plus whoever registered today.
  const identities = new Map<string, SegmentAgentIdentity>();
  for (const a of prev.agents as Json[])
    identities.set(a.id, {
      id: a.id,
      address: a.address,
      baseline: a.baseline ?? false,
      ...(a.participant !== undefined ? { participant: a.participant } : {}),
      includedTxCount: 0,
      revertCount: 0,
    });
  let endedAt: string | undefined;
  await lines(eventsPath, (l) => {
    if (l.includes('"agent_external_registered"')) {
      const e = JSON.parse(l) as Json;
      if (e.type === "agent_external_registered" && !identities.has(e.agentId))
        identities.set(e.agentId, {
          id: e.agentId,
          address: e.address,
          baseline: false,
          ...(e.participant !== undefined ? { participant: e.participant } : {}),
          includedTxCount: 0,
          revertCount: 0,
        });
    } else if (l.includes('"interval_boundary"') || l.includes('"epoch_boundary"')) {
      const e = JSON.parse(l) as Json;
      if (e.blockNumber === toBlock) endedAt = e.ts;
    }
  });
  // The day's transactions inside the scored window, counted the way the coordinator counts them.
  let header: string[] | null = null;
  await lines(join(dir, "blocks.csv"), (l) => {
    const cells = l.split(",");
    if (!header) return void (header = cells);
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    if (row.role !== "agent" || Number(row.blockNumber) > toBlock) return;
    const a = identities.get(row.ownerId);
    if (!a) return;
    a.includedTxCount++;
    if (row.status !== "success") a.revertCount++;
  });

  const segment = Number(scenarios[at].seed ?? at);
  const { summary, records, indexAgents } = closeCrashedSegment({
    runId: `${periodId}/segment-${segment}`,
    segment,
    fromBlock: Number(scenarios[at].fromBlock),
    intervalBlocks: Number(prevSeries.intervalBlocks ?? prevSeries.epochBlocks),
    mode: prev.mode,
    resetUnit: prev.resetUnit,
    blockTimeSec: prev.blockTimeSec,
    previous: { boundaryBlocks: prevSeries.boundaryBlocks, valuesByAgent: prevSeries.valuesByAgent },
    lines: boundaryLines,
    identities: [...identities.values()],
    note:
      "the coordinator exited before this segment rolled; closed afterwards from its own " +
      `${boundaryFile}, ending at the last boundary it read (block ${toBlock})`,
  });
  const scored = records.filter((r) => r.scored).length;
  console.log(
    `${dir}: blocks ${scenarios[at].fromBlock}..${toBlock}, ${boundaryLines.length} boundaries` +
      ` (+1 carried), ${scored} scored / ${records.length - scored} unscored` +
      ` [${records.filter((r) => !r.scored).map((r) => r.id).join(", ")}], ended ${endedAt ?? "?"}`,
  );
  for (const r of records)
    console.log(
      `  ${r.id.padEnd(22)} ${r.scored ? `P ${r.pnlUsdc.toFixed(2).padStart(10)}  V0 ${r.initialValueUsdc.toFixed(2)}` : "unscored"}  tx ${r.includedTxCount}/${r.revertCount} reverted`,
    );
  if (!write) return void console.log("dry run: pass --write to write summary.json and matrix.json");
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  scenarios[at] = {
    ...scenarios[at],
    toBlock,
    ...(endedAt ? { endedAt } : {}),
    agents: indexAgents,
  };
  const tmp = `${matrixPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(matrix, null, 2)}\n`);
  renameSync(tmp, matrixPath);
  console.log(`wrote ${join(dir, "summary.json")} and closed its entry in ${matrixPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
