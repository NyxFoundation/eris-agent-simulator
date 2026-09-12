import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pythonSchemas, snakeCase } from "../scripts/pythonSdkSchema.js";
import { ACTION_TYPES_BY_PROTOCOL } from "@eris/sdk/action.js";
import { PYTHON_ACTION_VOCABULARY } from "@eris/sdk/pythonVocabulary.js";
import { sized, canFund, balanceOf } from "../example/agents/lib/affordable.js";
import { marketViews } from "../example/agents/lib/markets.js";
import { pythonObservation } from "./helpers/python.js";

test("committed Python schemas and vocabulary cover every authoritative field/action", () => {
  const { action, observation, members } = pythonSchemas();
  assert.deepEqual(
    JSON.parse(readFileSync("sdk-py/schema/action.json", "utf8")),
    action,
  );
  assert.deepEqual(
    JSON.parse(readFileSync("sdk-py/schema/observation.json", "utf8")),
    observation,
  );
  const expected = [
    ...Object.values(ACTION_TYPES_BY_PROTOCOL).flat(),
    "noop",
    "bundle",
    "rawTx",
    "rawBundle",
  ].sort();
  assert.deepEqual(
    members.map((m) => m.properties.type.const).sort(),
    expected,
  );
  assert.deepEqual(Object.keys(PYTHON_ACTION_VOCABULARY).sort(), expected);
  const constructors = readFileSync("sdk-py/eris/actions.py", "utf8");
  for (const type of expected)
    assert.ok(constructors.includes(` as ${snakeCase(type)},`));
});

test("Python sizing and multi-market helpers match TypeScript with exact integer balances", () => {
  const obs = pythonObservation();
  obs.fairPricesUsd = { WBTC: 60000, WETH: 3000, EMPTY: 0 };
  obs.baseBalances = { WBTC: "100000000000000000" };
  obs.baseDecimals = { WETH: 18, WBTC: 8 };
  obs.protocols.uniswap!.markets = {
    "WBTC/USDC": {
      pair: "WBTC/USDC",
      fee: 500,
      priceUsdcPerWeth: 59000,
      tick: 0,
      tickSpacing: 10,
    },
  };
  const tokens = ["USDC", "WETH", "WBTC", "UNKNOWN"];
  const fractions = [-1, 0, 0.5, 1000.5, 10000, 10001];
  const expected = {
    balances: tokens.map((token) => balanceOf(obs, token).toString()),
    funded: tokens.map((token) => canFund(obs, token)),
    sizes: tokens.map((token) =>
      fractions.map((bps) => sized(obs, token, bps).toString()),
    ),
    markets: marketViews(obs).map((m) => ({
      base: m.base,
      fair: m.fair,
      base_balance_wei: m.baseBalanceWei,
      base_decimals: m.baseDecimals,
      venues: m.venues.map((v) => ({
        protocol: v.protocol,
        swap_type: v.swapType,
        price: v.price,
        fee_bps: v.feeBps,
        sell_price: v.sellPrice ?? null,
        buy_price: v.buyPrice ?? null,
      })),
    })),
  };
  const actual = execFileSync(
    process.env.ERIS_PYTHON ?? "python3",
    [
      "-c",
      `
import sys, json
from dataclasses import asdict
from eris import Observation
from eris.affordable import balance_of, can_fund, sized
from eris.markets import market_views
r = json.load(sys.stdin)
obs = Observation.model_validate(r["obs"])
assert "uniswap" in obs.enabled_protocols
tokens, fractions = r["tokens"], r["fractions"]
print(json.dumps(dict(balances=[str(balance_of(obs,t)) for t in tokens], funded=[can_fund(obs,t) for t in tokens], sizes=[[str(sized(obs,t,b)) for b in fractions] for t in tokens], markets=[asdict(m) for m in market_views(obs)])))
`,
    ],
    {
      input: JSON.stringify({ obs, tokens, fractions }),
      env: { ...process.env, PYTHONPATH: resolve("sdk-py") },
      timeout: 5000,
      encoding: "utf8",
    },
  );
  assert.deepEqual(JSON.parse(actual), expected);
});
