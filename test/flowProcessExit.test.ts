// Issue #159: the flow bot is the environment's market, and when its process died nothing said so --
// pushContext just started returning false. The coordinator now writes `flow_process_exited`, which the
// exporter counts as an environment failure. These pin the two halves: the bot going on its own is
// reported, and the coordinator closing it at the end of the run is not.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { RealtimeFlowProcess } from "../core/src/realtime/flowProcess.js";

test("a flow bot that exits on its own is reported once, with its exit code", async () => {
  const bot = new RealtimeFlowProcess(
    process.execPath,
    ["-e", "process.stderr.write('boom\\n'); process.exit(3)"],
    1,
    tmpdir(),
  );
  const info = await new Promise<{ code?: number; reason: string }>(
    (resolve) => {
      bot.onExit = resolve;
    },
  );
  assert.equal(info.code, 3);
  assert.match(info.reason, /exited before the run ended \(code 3\)/);
  assert.equal(bot.isAlive(), false);
});

test("closing the bot at the end of the run is not reported", async () => {
  const bot = new RealtimeFlowProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    1,
    tmpdir(),
  );
  let reported = false;
  bot.onExit = () => {
    reported = true;
  };
  bot.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reported, false);
  assert.equal(bot.isAlive(), false);
});
