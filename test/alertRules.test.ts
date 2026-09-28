// The Grafana alert rules (infra/monitoring/grafana/provisioning/alerting/rules.yml), evaluated by
// Prometheus's own rule engine over synthetic series (test/fixtures/alert-rules/promtool-tests.yml).
//
// Each Grafana rule is a PromQL query (refId A) plus a threshold (refId C). The test turns every rule
// into the equivalent Prometheus alerting rule -- `(<A>) <op> <threshold>`, same `for` -- and runs
// `promtool check rules` and `promtool test rules` on it. That catches a query that does not parse
// (Grafana would only say so at provisioning time, on the box) and pins what the routine-check rules
// of issue #157 / #159 are for: which series make them fire and, as much, which must not -- a stalled
// chain is not a stopped flow bot, a dead exporter is not a blind container reader, one send failure
// in 2,700 is not a page.
//
// Skipped where promtool is not installed (CI). `brew install prometheus` provides it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const RULES = join(
  ROOT,
  "infra/monitoring/grafana/provisioning/alerting/rules.yml",
);
const TESTS = join(ROOT, "test/fixtures/alert-rules/promtool-tests.yml");
const hasPromtool = spawnSync("promtool", ["--version"]).status === 0;

type GrafanaRule = {
  uid: string;
  for?: string;
  noDataState?: string;
  data: Array<{
    refId: string;
    model: {
      expr?: string;
      type?: string;
      conditions?: Array<{ evaluator: { type: string; params: number[] } }>;
    };
  }>;
};

function grafanaRules(): GrafanaRule[] {
  const doc = parse(readFileSync(RULES, "utf8")) as {
    groups: Array<{ rules: GrafanaRule[] }>;
  };
  return doc.groups.flatMap((g) => g.rules);
}

test("every Grafana rule is a query and a threshold on it", () => {
  const rules = grafanaRules();
  assert.equal(
    new Set(rules.map((r) => r.uid)).size,
    rules.length,
    "uids are unique",
  );
  for (const r of rules) {
    const a = r.data.find((d) => d.refId === "A");
    const c = r.data.find((d) => d.refId === "C");
    assert.ok(a?.model.expr, `${r.uid}: refId A has an expr`);
    assert.equal(
      c?.model.type,
      "threshold",
      `${r.uid}: refId C is a threshold`,
    );
  }
});

test(
  "the alert rules parse and fire on what they are for, and not on what they are not",
  { skip: !hasPromtool },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "eris-alert-rules-"));
    try {
      const rules = grafanaRules().map((r) => {
        const expr = r.data.find((d) => d.refId === "A")!.model.expr!;
        const ev = r.data.find((d) => d.refId === "C")!.model.conditions![0]
          .evaluator;
        const op = { gt: ">", lt: "<" }[ev.type];
        assert.ok(op, `${r.uid}: evaluator ${ev.type} is translated`);
        return {
          alert: r.uid,
          expr: `(${expr}) ${op} ${ev.params[0]}`,
          for: r.for ?? "0s",
        };
      });
      writeFileSync(
        join(dir, "rules.generated.yml"),
        stringify({ groups: [{ name: "grafana", rules }] }),
      );
      copyFileSync(TESTS, join(dir, "promtool-tests.yml"));
      const check = spawnSync(
        "promtool",
        ["check", "rules", "rules.generated.yml"],
        { cwd: dir, encoding: "utf8" },
      );
      assert.equal(check.status, 0, check.stdout + check.stderr);
      const run = spawnSync(
        "promtool",
        ["test", "rules", "promtool-tests.yml"],
        { cwd: dir, encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
