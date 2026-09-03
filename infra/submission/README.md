# infra/submission — agent submission safety scan

`scan-submission.py` statically screens a submitted agent (ZIP or directory) BEFORE the operator accepts
it / builds the per-team image. It is defense-in-depth in front of the runtime container caps
(`infra/docker-agent` — 1GB/OOM, 0.5 CPU, pids-limit, read-only rootfs, no-new-privileges): reject the
cheap, obvious abuse at the door so it never reaches the box.

```bash
python3 infra/submission/scan-submission.py <agent.zip|dir> [--json]
# exit 0 = accept (no BLOCK), 1 = reject (>=1 BLOCK). WARN/INFO never fail — operator eyeballs them.
```

Checks: zip-bomb (compression ratio, declared size, file count, path traversal), native/binary blobs,
oversized files; source red flags in .ts/.js — child_process/exec, eval/Function/vm, raw sockets
(net/dns/tls), fs writes, chain cheatcodes (anvil_/evm_setBalance/setStorageAt), outbound HTTP/WS
(WARN — confirm it targets the allowed RPC/LLM), process.env reads (WARN); package.json install
lifecycle hooks (supply-chain) and non-registry deps; hardcoded secrets and crypto-miner signatures.

Calibration: all 24 `example/agents/*` accept (0 BLOCK); a sample agent using child_process + fetch +
fs writes + a cheatcode + a postinstall hook is rejected (4 BLOCK). Not a sandbox and not exhaustive —
the runtime container is the real boundary; this rejects the obvious stuff early.
