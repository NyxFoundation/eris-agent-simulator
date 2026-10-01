// Refuse a local Aave whose Pool still lists a reserve the environment does not own (issue #190).
//
// @aave/deploy-v3 lists eight reserves on its own test tokens, with fixed-price aggregators and a
// Faucet that (unless deployed permissioned) mints 10,000 of each to anyone. The environment never
// uses them -- agents, flow actors and victims all work on the shared reserves the deployer adds --
// but the Aave adapter scores `getUserAccountData`, which sums *every* reserve in the Pool. So an
// active vendor reserve is free score (supply faucet tokens) and free collateral (borrow the shared
// USDC/WETH against them). The deployer now closes them (`closeVendorTestMarket`); this is the check
// that the deployment a run points at actually got that.
//
// It enumerates `Pool.getReservesList()` rather than naming the vendor tokens. Naming them is how
// the hole stayed open: the deployer recorded five of the eight, the mint guard probed the scored
// tokens, and neither looked at what the Pool would accept as collateral. What matters is not which
// tokens are dangerous but which reserves are ours, and that set is short: the token registry plus
// the LST share token (listed as collateral, deliberately kept out of the registry).
//
// An active reserve is a finding unless it is frozen *and* no participant holds anything in it.
// Freezing stops new supply and borrow, but a frozen reserve somebody still supplies keeps counting
// in getUserAccountData -- the state the deployer leaves when it could not deactivate a reserve that
// had been used. That is a decision for the operator (who supplied it, and what it means for the
// period's scores), not something a run should start on top of. What is left when everyone has
// repaid and withdrawn is the treasury's cut of the interest, which Aave never lets a reserve be
// deactivated over and which nobody but the treasury holds; a frozen reserve with only that in it
// is closed, and refusing it would leave a used chain with no state it could ever start from.
//
// Every chain mode, unlike gmxFundingEnforcement: here a running chain has a fix that is not a
// re-bake (`cd deployer && npm run close:aave-vendor`), so stopping does not strand anyone. On a
// local anvil that fix has to land in the `.local-snapshot` cross-section, not on top of it, or the
// reset at the start of the next run undoes it (`--revert-local-snapshot`; the closer refuses to
// send anything there without it).
import type { Address, PublicClient } from "viem";
import { parseAbi } from "viem";
import { AAVE, LST } from "@eris/sdk/constants.js";
import { tokenRegistry } from "@eris/sdk/markets.js";

const poolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
]);
const dataProviderAbi = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function RESERVE_TREASURY_ADDRESS() view returns (address)",
]);

export type AaveReserveState = {
  asset: Address;
  active: boolean;
  frozen: boolean;
  ltvBps: number;
  liquidationThresholdBps: number;
  // aTokens held by anyone but the reserve's treasury, and total debt. Raw units.
  participantSupply: bigint;
  debt: bigint;
};

// The reserves the environment owns: every registry token, plus the LST share token.
export function environmentReserveAssets(): Set<string> {
  const out = new Set(
    Object.values(tokenRegistry()).map((t) => t.address.toLowerCase()),
  );
  if (LST?.lstToken) out.add(LST.lstToken.toLowerCase());
  return out;
}

// Active reserves outside the environment's set. Pure, so the rule is testable without a chain.
export function strayAaveReserves(
  reserves: AaveReserveState[],
  ours: Set<string>,
): AaveReserveState[] {
  return reserves.filter(
    (r) =>
      r.active &&
      !ours.has(r.asset.toLowerCase()) &&
      !(r.frozen && r.participantSupply === 0n && r.debt === 0n),
  );
}

export async function readAaveReserves(
  publicClient: PublicClient,
): Promise<AaveReserveState[]> {
  const assets = await publicClient.readContract({
    address: AAVE.Pool,
    abi: poolAbi,
    functionName: "getReservesList",
  });
  return Promise.all(
    assets.map(async (asset) => {
      const cfg = await publicClient.readContract({
        address: AAVE.PoolDataProvider,
        abi: dataProviderAbi,
        functionName: "getReserveConfigurationData",
        args: [asset],
      });
      const [aToken, stableDebt, variableDebt] = await publicClient.readContract({
        address: AAVE.PoolDataProvider,
        abi: dataProviderAbi,
        functionName: "getReserveTokensAddresses",
        args: [asset],
      });
      const supply = (token: Address) =>
        publicClient.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" });
      const treasury = await publicClient.readContract({
        address: aToken,
        abi: tokenAbi,
        functionName: "RESERVE_TREASURY_ADDRESS",
      });
      const [supplied, treasurySupply, sDebt, vDebt] = await Promise.all([
        supply(aToken),
        publicClient.readContract({
          address: aToken,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [treasury],
        }),
        supply(stableDebt),
        supply(variableDebt),
      ]);
      return {
        asset,
        active: cfg[8],
        frozen: cfg[9],
        ltvBps: Number(cfg[1]),
        liquidationThresholdBps: Number(cfg[2]),
        participantSupply: supplied - treasurySupply,
        debt: sDebt + vDebt,
      };
    }),
  );
}

export function strayAaveReservesMessage(stray: AaveReserveState[]): string {
  const lines = stray.map(
    (r) =>
      `  - ${r.asset} (LTV ${r.ltvBps / 100}% / LT ${r.liquidationThresholdBps / 100}%` +
      (r.frozen
        ? `, frozen -- participants still hold ${r.participantSupply} aTokens / ${r.debt} debt there`
        : "") +
      ")",
  );
  return (
    "[aave] the Pool lists active reserves the environment does not own:\n" +
    `${lines.join("\n")}\n` +
    "These are @aave/deploy-v3's own test-token reserves (issue #190). The Aave score is " +
    "getUserAccountData, which sums every reserve, so with these active a participant can supply " +
    "test tokens (minted by the vendor Faucet) and have them counted as value, or borrow the shared " +
    "USDC/WETH against them.\n" +
    "Fix: on a local deploy, redeploy (`cd deployer && npm run deploy -- --keep-fresh`, then " +
    "`npm run gen:local-constants` / `npm run gen:state-dump`), or close them in place with " +
    "`cd deployer && npm run close:aave-vendor -- --revert-local-snapshot`. A close sent on top of " +
    "a local anvil without that flag is undone here: this run starts by reverting to " +
    "`.local-snapshot`, taken before the close (the closer refuses in that case; deleting " +
    "`.local-snapshot` first also works, and makes the chain as it is the base). On a chain that " +
    "is already running and never reset (the practice devnet), " +
    "`cd deployer && RPC_URL=<node> npm run close:aave-vendor`. A reserve it can only freeze " +
    "already holds somebody's supply: find out whose before going on."
  );
}
