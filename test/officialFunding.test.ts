// Every official regime, and the practice period that stands in for them, hands every agent the same
// endowment, gas ETH included (rules §4.2: identical for all participants, gas ETH counts in asset
// value, and its amount is published). The flow wallets' side is pinned in flowTrendInventory.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const OFFICIAL = (parse(readFileSync("config/scenarios/public.yaml", "utf8")) as { regimes: string[] }).regimes;
const FILES = [...OFFICIAL.map((n) => `config/regimes/${n}.yaml`), "config/practice.yaml"];
const ONE_ETH = "1000000000000000000";

type Funding = { wethWei?: string; base?: Record<string, string>; usdcUnits?: string; ethWei?: string };

function funding(path: string): Funding {
  return (parse(readFileSync(path, "utf8")) as { funding: Funding }).funding;
}

test("the official regimes and the practice period fund agents identically, gas ETH included", () => {
  const shapes = FILES.map((p) => {
    const f = funding(p);
    return JSON.stringify({ wethWei: f.wethWei, base: f.base, usdcUnits: f.usdcUnits, ethWei: f.ethWei });
  });
  assert.equal(new Set(shapes).size, 1, `agent funding differs:\n${FILES.map((p, i) => `${p} ${shapes[i]}`).join("\n")}`);
});

test("gas ETH is stated as the published 1 ETH, not left to a default", () => {
  for (const p of FILES) assert.equal(funding(p).ethWei, ONE_ETH, `${p}: funding.ethWei is ${funding(p).ethWei}`);
});
