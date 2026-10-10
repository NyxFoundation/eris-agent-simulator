// The deployer's standing approvals, granted in every run whatever the schedule holds (rules §3.3).
//
// Three stress mechanisms trade as the deployer account: `depeg` and `eusdDepeg` sell a stable into
// its pool and buy it back, and `liquidityPull` withdraws the seeded depth and puts it back. Each
// needs a standing approval the deploy did not leave (the deploy approved exactly what it seeded),
// and each used to send its own at setup -- so the setup blocks of a depeg, depeg-persist, crash, spike,
// lending-incident or cdp-incident run carried `approve(pool, max)` transactions from the
// deployer, a public address, that the others did not. An agent reading the chain's history before
// its first block could tell those regimes apart from the rest, and lending-incident and
// cdp-incident say a crash is coming.
//
// So the approvals are a function of the deployment, not of the schedule: every pull-capable venue
// this run enabled, every base it has a market for, every market-priced stable the deployer holds.
// The mechanisms themselves only check that the approval is in place (`requireStandingApprovals`).
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { erc20Abi } from "@eris/sdk/abis.js";
import { accountAddress, sendBatch } from "@eris/sdk/chain.js";
import { TOKENS } from "@eris/sdk/constants.js";
import { baseTokens } from "@eris/sdk/markets.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import { marketPricedStables } from "@eris/sdk/stables.js";
import {
  approvalsFor,
  discoverPullPositions,
  type PullVenue,
} from "./liquidityVenues.js";

export type StandingApproval = { token: Address; spender: Address };

// An allowance at least this large counts as standing. maxUint256 is what is granted; spending
// against it lowers it only for tokens that decrement an infinite allowance, and never by half.
const STANDING_THRESHOLD = maxUint256 / 2n;

function dedupe(approvals: StandingApproval[]): StandingApproval[] {
  const byKey = new Map<string, StandingApproval>();
  for (const a of approvals)
    byKey.set(`${a.token.toLowerCase()}:${a.spender.toLowerCase()}`, a);
  return [...byKey.values()];
}

/// Every approval the deployer's stress mechanisms could need on this deployment. Read-only.
///
/// What it depends on is the point: the enabled venues, the deployment's markets and what the owner
/// holds -- all identical across the regimes of one deployment. A position or a stable the owner does
/// not hold is skipped rather than refused; the mechanism that needs it refuses on its own, in the
/// regime that asks for it, as it always has.
export async function deployerStandingApprovals(
  ctx: SimContext,
  owner: Address,
  pullVenues: PullVenue[],
): Promise<StandingApproval[]> {
  const out: StandingApproval[] = [];
  const bases = baseTokens().map((t) => t.symbol);
  const { positions } = await discoverPullPositions(ctx, pullVenues, bases, owner);
  for (const pos of positions) out.push(...approvalsFor(pos));
  const stables = marketPricedStables();
  const held = (await Promise.all(
    stables.map((m) =>
      ctx.publicClient.readContract({
        address: m.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
  )) as bigint[];
  stables.forEach((m, i) => {
    if (held[i] === 0n) return;
    out.push({ token: m.token, spender: m.pool });
    out.push({ token: TOKENS.USDC.address, spender: m.pool });
  });
  return dedupe(out);
}

/// Grant them, in one batch from the owner's key. Returns what was granted.
export async function grantDeployerStandingApprovals(
  ctx: SimContext,
  ownerPk: Hex,
  pullVenues: PullVenue[],
): Promise<StandingApproval[]> {
  const approvals = await deployerStandingApprovals(
    ctx,
    accountAddress(ownerPk),
    pullVenues,
  );
  await sendBatch(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ownerPk,
    approvals.map(({ token, spender }) => ({
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      }),
    })),
  );
  return approvals;
}

/// Refuse to stage a mechanism whose approvals are not standing. Granting them here instead is what
/// this module exists to stop: it would put the mechanism's own transactions back in the setup blocks.
export async function requireStandingApprovals(
  ctx: SimContext,
  owner: Address,
  approvals: StandingApproval[],
  mechanism: string,
): Promise<void> {
  const allowances = (await Promise.all(
    approvals.map((a) =>
      ctx.publicClient.readContract({
        address: a.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, a.spender],
      }),
    ),
  )) as bigint[];
  const missing = approvals.filter((_, i) => allowances[i] < STANDING_THRESHOLD);
  if (missing.length > 0)
    throw new Error(
      `${mechanism}: ${owner} has no standing approval for ` +
        missing.map((a) => `${a.token} -> ${a.spender}`).join(", ") +
        ". The coordinator grants these at setup in every run (core/src/realtime/standingApprovals.ts); " +
        "a mechanism that grants its own would name its regime in the setup blocks",
    );
}
