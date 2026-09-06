// Mock LLM server for load-testing the IMPROVE HARNESS without Ollama. Speaks the ollama /api/chat
// contract llm.ts expects ({message:{content:"<revision JSON string>"}}), so pointing
// ERIS_OLLAMA_BASE_URL at it makes 100 agents run the full improve downstream (JSON parse -> validate
// -> cheatcode check -> node:vm compile -> install) at their real cadence, with ZERO LLM latency or
// concurrency wall. That isolates the harness cost (compile CPU, install rate, round timing, teardown)
// from the LLM infra bottleneck (which the operator proxy solves separately, docs/23 track B).
//
// Returns a controlled OUTCOME MIX (per-request rotation) so every downstream branch is exercised at
// scale: install / declined / malformed-JSON reject / import-compile reject.
//   MOCK_LLM_PORT (11500)   MOCK_LLM_DELAY_MS (0 — add latency without a concurrency cap if wanted)
import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT || 11500);
const DELAY = Number(process.env.MOCK_LLM_DELAY_MS || 0);

// a valid decide() body: does a little Math over the observation (realistic compile+exec cost) then noop
const INSTALL_BODY =
  "let acc = 0; const v = (obs && obs.venues) || []; " +
  "for (let i = 0; i < v.length; i++) { acc += Math.abs((v[i] && v[i].mid) || 0); } " +
  "if (acc < 0) return { type: 'noop' }; return { type: 'noop' };";

let n = 0;
const revision = (i) => {
  const r = i % 10;
  if (r <= 5) return JSON.stringify({ notes: "mock install " + i, executorTs: INSTALL_BODY }); // 60% install
  if (r <= 7) return JSON.stringify({ notes: "mock keep", executorTs: null });                 // 20% declined
  if (r === 8) return "{ this is not valid json";                                               // 10% JSON reject
  return JSON.stringify({ notes: "bad", executorTs: "import x from 'y'; return { type: 'noop' };" }); // 10% compile reject
};

const server = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(200); return res.end("mock-llm ok\n"); }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const content = revision(n++);
    const body = JSON.stringify({ model: "mock", done: true, message: { role: "assistant", content } });
    const send = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };
    DELAY > 0 ? setTimeout(send, DELAY) : send();
  });
});
server.listen(PORT, "127.0.0.1", () => process.stdout.write(`mock-llm :${PORT} delay=${DELAY}ms mix=60/20/10/10\n`));
