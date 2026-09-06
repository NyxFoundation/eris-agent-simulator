/**
 * agent-state: the operator's handle on the per-agent persistent area (#77).
 *
 * The coordinator snapshots every agent's state at the start of every epoch. Rules §4.4.2 lets a
 * voided epoch be re-run with the same seed, and a re-run that starts from the state the *first*
 * attempt ended with is a different experiment — so the snapshot has to be restorable, by hand, by
 * whoever voided the epoch. Without this the snapshot is a file nobody can use, and the clause is a
 * promise the code does not keep.
 *
 *   npm run agent-state -- list --root runs/state
 *   npm run agent-state -- list --root runs/state --run 2026-09-22T09-14-03-118Z
 *   npm run agent-state -- restore --root runs/state --run 2026-09-22T09-14-03-118Z
 *   npm run agent-state -- restore --root runs/state --run <id> --agent venue-arb
 *
 * `restore` puts each agent back to what that epoch started with, and then the epoch is re-run
 * normally. It is deliberately not automatic: voiding an epoch is a judgment (§4.4.2), and a
 * harness that restored on its own would be making it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags } from "../backtest/shared.js";
import { restoreAgentState, SNAPSHOT_DIR } from "../realtime/agentState.js";

const USAGE = `usage: npm run agent-state -- <list|restore> --root <dir> [--run <epoch run id>] [--agent <id>]
  list                   epochs with a snapshot, newest last; with --run, the agents in that one
  restore                put each agent's state back to what that epoch started with (rules §4.4.2)
  --root <dir>           the agent state root (the --agent-state-root the run used)
  --run <id>             the run id of the epoch, as it appears under <root>/${SNAPSHOT_DIR}/
  --agent <id>           restore only this agent (default: every agent in the snapshot)`;

function snapshotRoot(root: string): string {
  const base = join(root, SNAPSHOT_DIR);
  if (!existsSync(base))
    throw new Error(
      `${base} does not exist — this root has no snapshots (was the run given --agent-state-root?)`,
    );
  return base;
}

function dirsIn(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function main(): void {
  const command = process.argv[2];
  const flags = parseFlags(process.argv);
  if (command !== "list" && command !== "restore") {
    console.error(USAGE);
    throw new Error(`unknown command ${JSON.stringify(command ?? "")}`);
  }
  if (!flags.root) {
    console.error(USAGE);
    throw new Error("--root is required");
  }
  const root = resolve(process.cwd(), flags.root);
  const base = snapshotRoot(root);

  if (command === "list") {
    if (!flags.run) {
      const epochs = dirsIn(base)
        .map((name) => ({ name, mtimeMs: statSync(join(base, name)).mtimeMs }))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      if (epochs.length === 0) {
        console.log("no snapshots");
        return;
      }
      for (const { name, mtimeMs } of epochs)
        console.log(
          `${name}\t${new Date(mtimeMs).toISOString()}\t${dirsIn(join(base, name)).length} agents`,
        );
      return;
    }
    const epochDir = join(base, flags.run);
    if (!existsSync(epochDir))
      throw new Error(`no snapshot for run ${flags.run} under ${base}`);
    for (const agentId of dirsIn(epochDir)) console.log(agentId);
    return;
  }

  if (!flags.run) {
    console.error(USAGE);
    throw new Error("--run is required for restore");
  }
  const epochDir = join(base, flags.run);
  if (!existsSync(epochDir))
    throw new Error(`no snapshot for run ${flags.run} under ${base}`);
  const agents = flags.agent ? [flags.agent] : dirsIn(epochDir);
  if (agents.length === 0)
    throw new Error(`snapshot ${flags.run} holds no agent directories`);
  let restored = 0;
  for (const agentId of agents) {
    // Reported per agent rather than as a total: a restore that silently skipped one agent puts
    // that agent into the re-run with the state of the attempt being thrown away, which is the one
    // outcome this command exists to prevent.
    if (restoreAgentState(root, agentId, flags.run)) {
      console.log(`restored ${agentId} to the start of ${flags.run}`);
      restored++;
    } else {
      console.error(`no snapshot for ${agentId} in ${flags.run} — left as it is`);
    }
  }
  console.log(`${restored}/${agents.length} agents restored`);
  if (restored !== agents.length)
    throw new Error("some agents were not restored; do not re-run the epoch yet");
}

main();
