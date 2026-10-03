// Report whether this deployment lets a GMX order carry a callback.
//
// GMX runs an order's callbackContract inside the keeper's executeOrder, and the keeper's transaction
// sits just under the oracle's, above every participant. A callback was therefore the creator's code
// at the top of every block, under the keeper's fee and gas and attributed to the keeper. Two layers
// close it:
//   - the keeper refuses any order with a callbackContract (gmxKeeperRefusal in
//     sdk/src/protocols/gmx.ts). This holds on every chain, whatever it was deployed with;
//   - deployer/vendor/gmx-localhost.patch sets MAX_CALLBACK_GAS_LIMIT and
//     REFUND_EXECUTION_FEE_GAS_LIMIT to 0, so createOrder reverts on a non-zero callbackGasLimit and
//     the refund callback gets no gas. Only on deploys baked after it.
//
// This reads the second layer and records it. It does not stop the run: the keeper's refusal
// already closes the hole, and the only difference on an older deploy is where such an order ends
// up -- unexecuted in the OrderVault until its creator cancels it, rather than reverting at
// createOrder. Failing every state dump baked before the patch for that would be a re-bake for a
// difference no score sees.
import type { PublicClient } from "viem";
import { GMX } from "@eris/sdk/constants.js";
import {
  GMX_MAX_CALLBACK_GAS_LIMIT_KEY,
  GMX_REFUND_EXECUTION_FEE_GAS_LIMIT_KEY,
  gmxDataStoreReadAbi,
} from "@eris/sdk/protocols/gmxKeys.js";

export type GmxCallbackLimitsRead = {
  // Absent when the read failed, which is not a zero.
  maxCallbackGasLimit?: bigint;
  refundExecutionFeeGasLimit?: bigint;
  error?: string;
};

export type GmxCallbackCheck = {
  // Both limits read and both 0: no order on this deploy can carry a callback with gas.
  closedAtDeploy: boolean;
  maxCallbackGasLimit: string | null;
  refundExecutionFeeGasLimit: string | null;
  error?: string;
};

/** The decision, pure. */
export function gmxCallbackCheck(
  read: GmxCallbackLimitsRead,
): GmxCallbackCheck {
  return {
    closedAtDeploy:
      read.maxCallbackGasLimit === 0n && read.refundExecutionFeeGasLimit === 0n,
    maxCallbackGasLimit: read.maxCallbackGasLimit?.toString() ?? null,
    refundExecutionFeeGasLimit:
      read.refundExecutionFeeGasLimit?.toString() ?? null,
    ...(read.error !== undefined ? { error: read.error } : {}),
  };
}

/** What to tell the operator when the deploy still allows callbacks. */
export function gmxCallbackOpenMessage(check: GmxCallbackCheck): string {
  const values =
    check.error !== undefined
      ? `could not be read (${check.error})`
      : `are MAX_CALLBACK_GAS_LIMIT ${check.maxCallbackGasLimit} / ` +
        `REFUND_EXECUTION_FEE_GAS_LIMIT ${check.refundExecutionFeeGasLimit}`;
  return (
    `GMX's callback gas limits ${values}; a current deploy has both at 0 ` +
    "(deployer/vendor/gmx-localhost.patch). The keeper refuses every order with a " +
    "callbackContract (keeper_order_refused), so no participant code runs inside its " +
    "transaction; such an order stays in the OrderVault until its creator cancels it instead of " +
    "reverting at createOrder. Re-bake to close it at the deploy too: `cd deployer && npm run " +
    "clean:vendors && ./scripts/setup-vendors.sh && npm run deploy -- --keep-fresh`, then " +
    "`npm run gen:local-constants` and `npm run gen:state-dump`."
  );
}

/** Read both callback gas limits from the DataStore. */
export async function readGmxCallbackLimits(
  publicClient: Pick<PublicClient, "readContract">,
): Promise<GmxCallbackLimitsRead> {
  try {
    const read = (key: `0x${string}`) =>
      publicClient.readContract({
        address: GMX.DataStore,
        abi: gmxDataStoreReadAbi,
        functionName: "getUint",
        args: [key],
      }) as Promise<bigint>;
    const [maxCallbackGasLimit, refundExecutionFeeGasLimit] = await Promise.all(
      [
        read(GMX_MAX_CALLBACK_GAS_LIMIT_KEY),
        read(GMX_REFUND_EXECUTION_FEE_GAS_LIMIT_KEY),
      ],
    );
    return { maxCallbackGasLimit, refundExecutionFeeGasLimit };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
}
