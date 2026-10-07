// Issue #196: the LP valuation enumerated every NFT an agent holds, and an agent can mint as many
// as it likes for gas. Past LP_POSITIONS_LIMIT the positions are not read, and the agent's value
// says so (`uniswap-lp-unscanned`), the way the lending valuation reports `lending-unscanned`.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { TOKENS, UNISWAP } from "../sdk/src/constants.js";
import { PAR_STABLE_PRICES } from "../sdk/src/stables.js";
import { LP_POSITIONS_LIMIT, uniswapAdapter } from "../sdk/src/protocols/uniswap.js";
import type { ValuationContext, ValuationRead, ValuationRun } from "../sdk/src/protocols/types.js";

const LP = { id: "lp", address: "0x00000000000000000000000000000000000000aa" as Address };
const SPAMMER = { id: "spammer", address: "0x00000000000000000000000000000000000000bb" as Address };
type Call = { functionName: string; args?: readonly unknown[]; address: Address };

async function drive(run: ValuationRun, answer: (c: Call) => unknown) {
  const stages: ValuationRead[][] = [];
  let step = await run.next();
  while (!step.done) {
    stages.push(step.value);
    step = await run.next(step.value.map((r) => answer(r as unknown as Call)));
  }
  return { values: step.value, stages };
}

const ctx = (): ValuationContext => ({
  publicClient: {} as never,
  blockNumber: 100,
  horizonBlock: 100,
  agents: [LP, SPAMMER],
  activeStables: [TOKENS.USDC.address],
  fairByBase: () => ({ WETH: 2000 }),
  stablePrices: () => PAR_STABLE_PRICES,
  medianWindow: [],
});

test("an agent holding more LP NFTs than the bound has the first LP_POSITIONS_LIMIT read and the rest named", async () => {
  const total = BigInt(LP_POSITIONS_LIMIT + 5);
  const { values, stages } = await drive(uniswapAdapter.valueAtBlock!(ctx()), (c) => {
    if (c.functionName === "slot0") return [2n ** 96n, 0]; // a pool at price 1, tick 0
    if (c.functionName === "balanceOf")
      return (c.args?.[0] as string).toLowerCase() === SPAMMER.address ? total : 1n;
    if (c.functionName === "tokenOfOwnerByIndex") return 1000n + (c.args?.[1] as bigint);
    // positions / everything after: unreadable here, which is reported per position (#44) and is
    // not what this test is about.
    return undefined;
  });
  const enumerated = stages
    .flat()
    .filter((r) => r.functionName === "tokenOfOwnerByIndex" && (r.args?.[0] as string).toLowerCase() === SPAMMER.address);
  assert.equal(enumerated.length, LP_POSITIONS_LIMIT, "reads stop at the bound");
  const cut = values.spammer.unpriced.find((u) => u.source === "uniswap-lp-unscanned");
  assert.ok(cut, "the positions past the bound are named in the value");
  assert.equal(cut.amountRaw, "5");
  assert.match(cut.read ?? "", new RegExp(`${LP_POSITIONS_LIMIT} of ${total} positions read`));
  // The agent under the bound is not touched by the spammer's count.
  assert.equal(values.lp.unpriced.find((u) => u.source === "uniswap-lp-unscanned"), undefined);
  assert.equal(
    stages.flat().filter((r) => r.functionName === "tokenOfOwnerByIndex" && (r.args?.[0] as string).toLowerCase() === LP.address).length,
    1,
  );
  assert.ok(UNISWAP.nonfungiblePositionManager, "the NPM address is what the reads target");
});
