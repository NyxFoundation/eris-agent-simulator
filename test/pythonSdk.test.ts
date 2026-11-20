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

// eris.constants reads sdk/src/constants.local.ts itself rather than a second generated copy, so
// this is what keeps it honest: a change to the generator's layout, or to what constants.ts derives
// from the table (TOKENS.EUSD, STABLE_MARKET_LEGS, the require* helpers), that the Python side does
// not follow fails here, not as every Python agent exiting at the live week's first block.
// constants.ts picks its overlay at import time, so the TypeScript side runs in its own process.
test("eris.constants matches what @eris/sdk/constants.js derives from the same table", () => {
  const bigints = (_: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v;
  const typescript = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
import * as c from "@eris/sdk/constants.js";
import { LOCAL_DEPLOYMENT, DEPLOYMENTS_FINGERPRINT } from "@eris/sdk/constants.local.js";
const attempt = (f) => { try { return f(); } catch { return "error"; } };
const symbols = Object.keys(c.TOKENS);
process.stdout.write(JSON.stringify({
  table: { ...LOCAL_DEPLOYMENT, TOKENS: c.TOKENS },
  fingerprint: DEPLOYMENTS_FINGERPRINT,
  stableMarketLegs: c.STABLE_MARKET_LEGS,
  addresses: Object.fromEntries(symbols.map((s) => [s, c.tokenAddress(s)])),
  decimals: Object.fromEntries(symbols.map((s) => [s, c.tokenDecimals(s)])),
  symbols: [...symbols.map((s) => c.TOKENS[s].address), "0x0000000000000000000000000000000000000001"]
    .flatMap((a) => [a, a.toLowerCase()]).map((a) => c.symbolForAddress(a) ?? null),
  lst: attempt(() => c.requireLst()),
  liquity: attempt(() => c.requireLiquity()),
  redemptionHelper: attempt(() => c.requireRedemptionHelper()),
  eusdMarket: attempt(() => c.requireEusdMarket()),
}, ${bigints.toString()}));
`,
      ],
      {
        env: { ...process.env, ERIS_LOCAL_DEPLOY: "1" },
        timeout: 20000,
        encoding: "utf8",
      },
    ),
  );
  assert.ok(typescript.table.TOKENS.WETH, "the committed constants.local.ts has a table");
  const python = (env: Record<string, string | undefined>) =>
    JSON.parse(
      execFileSync(
        process.env.ERIS_PYTHON ?? "python3",
        [
          "-c",
          `
import json
from eris import constants as c
def safe(v):
    if isinstance(v, dict): return {k: safe(x) for k, x in v.items()}
    if isinstance(v, list): return [safe(x) for x in v]
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) >= 2**53: return str(v)
    return v
def attempt(f):
    try: return f()
    except c.ConstantsError: return "error"
try:
    table = c.local_deployment()
except c.ConstantsError as err:
    print(json.dumps(dict(error=str(err)))); raise SystemExit
symbols = list(table["TOKENS"])
addresses = [table["TOKENS"][s]["address"] for s in symbols] + ["0x0000000000000000000000000000000000000001"]
print(json.dumps(dict(
    table=safe(table),
    fingerprint=c.deployments_fingerprint(),
    stableMarketLegs=c.stable_market_legs(),
    addresses={s: c.token_address(s) for s in symbols},
    decimals={s: c.token_decimals(s) for s in symbols},
    symbols=[c.symbol_for_address(x) for a in addresses for x in (a, a.lower())],
    lst=attempt(c.require_lst),
    liquity=attempt(c.require_liquity),
    redemptionHelper=attempt(c.require_redemption_helper),
    eusdMarket=attempt(c.require_eusd_market),
)))
`,
        ],
        {
          env: { ...process.env, PYTHONPATH: resolve("sdk-py"), ...env },
          timeout: 5000,
          encoding: "utf8",
        },
      ),
    );
  assert.deepEqual(python({ ERIS_LOCAL_DEPLOY: "1" }), typescript);
  // TypeScript falls back to Arbitrum's addresses without ERIS_LOCAL_DEPLOY=1; no competition
  // environment runs that way, so Python refuses instead of handing out mainnet addresses.
  assert.match(
    python({ ERIS_LOCAL_DEPLOY: undefined }).error,
    /ERIS_LOCAL_DEPLOY is not 1/,
  );
});
