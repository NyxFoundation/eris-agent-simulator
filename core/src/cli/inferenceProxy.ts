// npm run inference-proxy -- --models <models.yaml> [--listen 127.0.0.1:8790] [--record <dir>] [--replay <dir>]
//
// The one door between agents and models (core/src/inference/proxy.ts). ERIS_INFERENCE_SECRET in
// this process's environment turns per-agent authentication on; the coordinator, started with the
// same secret, hands each agent its token. Upstream API keys are read from the variables the model
// list names (OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY, ...) -- here, never in an agent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFlags } from "../backtest/shared.js";
import { createInferenceProxy, loadProxyConfig } from "../inference/proxy.js";

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
const server = createInferenceProxy({
  config,
  ...(secret ? { secret } : {}),
  ...(flags.record ? { recordDir: resolve(process.cwd(), flags.record) } : {}),
  ...(flags.replay ? { replayDir: resolve(process.cwd(), flags.replay) } : {}),
});
server.listen(port, host, () => {
  console.error(
    `[inference-proxy] listening on http://${host}:${port} ` +
      `(${config.models.length} model(s); auth ${secret ? "on" : "OFF — set ERIS_INFERENCE_SECRET"}; ` +
      `${flags.replay ? `REPLAY from ${flags.replay}` : flags.record ? `recording to ${flags.record}` : "not recording"})`,
  );
});
