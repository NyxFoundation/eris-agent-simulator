// The dashboard's /blockscout forwarder (dashboard/server/explorerProxy.ts). The dashboard is public
// and the path is the caller's, so the only thing it may reach is the configured explorer's read API.
import test from "node:test";
import assert from "node:assert/strict";
import { explorerTarget } from "../dashboard/server/explorerProxy.js";

const BASE = "http://host.docker.internal:4000";

test("the explorer's read API is forwarded, with its query", () => {
  assert.equal(
    explorerTarget("/api/v2/stats", undefined, "GET", BASE)?.href,
    "http://host.docker.internal:4000/api/v2/stats",
  );
  assert.equal(
    explorerTarget("/api/v2/blocks", "type=block", "HEAD", BASE)?.href,
    "http://host.docker.internal:4000/api/v2/blocks?type=block",
  );
});

test("a path that names another origin is refused", () => {
  for (const rest of [
    "//ascon-prometheus:9090/-/healthy",
    "//ascon-prometheus:9090/api/v2/x",
    "/\\ascon-loki:3100/api/v2/x",
    "//example.com/api/v2/stats",
    "http://example.com/api/v2/stats",
  ])
    assert.equal(explorerTarget(rest, undefined, "GET", BASE), null, rest);
});

test("only the explorer's API, and only reads", () => {
  assert.equal(explorerTarget("/", undefined, "GET", BASE), null);
  assert.equal(explorerTarget("/api/v2/../../admin", undefined, "GET", BASE), null);
  assert.equal(explorerTarget("/api/v1/stats", undefined, "GET", BASE), null);
  assert.equal(explorerTarget("/api/v2/stats", undefined, "POST", BASE), null);
  assert.equal(explorerTarget("/api/v2/stats", undefined, undefined, BASE), null);
});
