// npm run inference-proxy -- --models <models.yaml> [--listen 127.0.0.1:8790] [--record <dir>] [--replay <dir>]
//
// The one door between agents and models (core/src/inference/proxy.ts). ERIS_INFERENCE_SECRET in
// this process's environment turns per-agent authentication on; the coordinator, started with the
// same secret, hands each agent its token. Upstream API keys are read from the variables the model
// list names (OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY, ...) -- here, never in an agent.
//
// ERIS_INFERENCE_STATS_TOKEN opens GET /admin/recording, which reports what the record has cost so
// far. It is the operator's own token: it is not handed to any agent and must not be the inference
// secret, because every agent can reach this proxy and the counts there are a reading of how often
// the rest of the field is revising (issue #218). Unset, the path does not exist and /healthz
// answers `{"ok":true}` and nothing else.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFlags } from "../backtest/shared.js";
import { createInferenceProxy, loadProxyConfig } from "../inference/proxy.js";

// This process is every agent's only path to a model (rules §2.3), so it does not exit over one
// call's failure (issue #215). The server wraps each request so a thrown handler is that call's 500;
// this is the last resort for a rejection nobody caught. It is logged and the proxy keeps serving.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[inference-proxy] unhandled rejection (still serving): ` +
      (reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)),
  );
});

const flags = parseFlags(process.argv);
if (!flags.models) {
  console.error(
    "usage: npm run inference-proxy -- --models <models.yaml> [--listen host:port] [--record <dir>] [--replay <dir>]",
  );
  process.exit(1);
}
const config = loadProxyConfig(
  parseYaml(readFileSync(resolve(process.cwd(), flags.models), "utf8")),
);
const [host, portText] = (flags.listen ?? "127.0.0.1:8790").split(":");
const port = Number(portText ?? "8790");
const secret = process.env.ERIS_INFERENCE_SECRET;
const statsToken = process.env.ERIS_INFERENCE_STATS_TOKEN;
// One value for both would hand the stats to anything holding the secret and make a typo in the
// operator's monitoring a forged agent token.
if (statsToken && secret && statsToken === secret) {
  console.error(
    "[inference-proxy] ERIS_INFERENCE_STATS_TOKEN must differ from ERIS_INFERENCE_SECRET",
  );
  process.exit(1);
}
const server = createInferenceProxy({
  config,
  ...(secret ? { secret } : {}),
  ...(statsToken ? { statsToken } : {}),
  ...(flags.record ? { recordDir: resolve(process.cwd(), flags.record) } : {}),
  ...(flags.replay ? { replayDir: resolve(process.cwd(), flags.replay) } : {}),
});
// A server error is a listen failure (the port is taken, the address is not ours): there is nothing
// to serve, so say what happened and exit rather than throw a stack.
server.on("error", (error) => {
  console.error(`[inference-proxy] cannot listen on ${host}:${port}: ${error.message}`);
  process.exit(1);
});
const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;
server.listen(port, host, () => {
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.error(
    `[inference-proxy] listening on http://${host}:${bound} ` +
      `(${config.models.length} model(s); auth ${secret ? "on" : "OFF — set ERIS_INFERENCE_SECRET"}; ` +
      `stats ${statsToken ? "at GET /admin/recording" : "off — set ERIS_INFERENCE_STATS_TOKEN"}; ` +
      `${
        flags.replay
          ? `REPLAY from ${flags.replay}`
          : flags.record
            ? `recording to ${flags.record}, at most ${mib(config.maxRecordBytesPerAgent!)} per agent ` +
              `and ${mib(config.maxRecordBytesTotal!)} in all`
            : "not recording"
      })`,
  );
});
