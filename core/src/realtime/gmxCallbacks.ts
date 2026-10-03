// Report whether this deployment lets GMX run a participant's code inside the keeper's transaction.
//
// The keeper's executeOrder sits just under the oracle's transaction, above every participant, so
// whatever participant code GMX calls from it runs at the top of the block, under the keeper's fee
// and gas and attributed to the keeper. GMX calls out in three places, each with its own gas:
//   - an order's callbackContract (afterOrderExecution / afterOrderCancellation), with the order's
//     callbackGasLimit, capped by MAX_CALLBACK_GAS_LIMIT;
//   - the same contract's refundExecutionFee, with REFUND_EXECUTION_FEE_GAS_LIMIT whatever the
//     order's limit;
//   - the order's receiver, when it is sent native ETH (the execution-fee refund, unwrapped
//     outputs), with NATIVE_TOKEN_TRANSFER_GAS_LIMIT -- a contract receiver's receive() runs.
// Two layers:
//   - the keeper refuses any order with a callbackContract (gmxKeeperRefusal in
//     sdk/src/protocols/gmx.ts). This holds on every chain, and covers the first two;
//   - deployer/vendor/gmx-localhost.patch sets all three limits to 0: createOrder reverts on a
//     non-zero callbackGasLimit, the refund callback gets no gas, and a native send carries only the
//     EVM's 2,300 stipend (no SSTORE; a receiver that needs more is paid in WETH instead). Only on
//     deploys baked after it, and the only layer for the third.
//
// This reads the second layer and records it. It does not stop the run. The callbacks are already
// closed by the keeper; on an older deploy such an order stays unexecuted in the OrderVault until its
// creator cancels it, rather than reverting at createOrder. What an older deploy does leave open is
// the receiver's 50,000 gas -- enough to write a little state, not to trade (a swap does not fit) --
// which is a warning and a re-bake, not a reason to refuse every state dump baked before the patch.
import type { PublicClient } from "viem";
import { GMX } from "@eris/sdk/constants.js";
import {
  GMX_MAX_CALLBACK_GAS_LIMIT_KEY,
  GMX_NATIVE_TOKEN_TRANSFER_GAS_LIMIT_KEY,
  GMX_REFUND_EXECUTION_FEE_GAS_LIMIT_KEY,
  gmxDataStoreReadAbi,
} from "@eris/sdk/protocols/gmxKeys.js";

export type GmxCallbackLimitsRead = {
  // Absent when the read failed, which is not a zero.
  maxCallbackGasLimit?: bigint;
  refundExecutionFeeGasLimit?: bigint;
  nativeTokenTransferGasLimit?: bigint;
  error?: string;
};

export type GmxCallbackCheck = {
  // All three limits read and all 0: GMX gives no participant code gas inside the keeper's transaction.
  closedAtDeploy: boolean;
  maxCallbackGasLimit: string | null;
  refundExecutionFeeGasLimit: string | null;
  nativeTokenTransferGasLimit: string | null;
  error?: string;
};

/** The decision, pure. */
export function gmxCallbackCheck(
  read: GmxCallbackLimitsRead,
): GmxCallbackCheck {
  return {
    closedAtDeploy:
      read.maxCallbackGasLimit === 0n &&
      read.refundExecutionFeeGasLimit === 0n &&
      read.nativeTokenTransferGasLimit === 0n,
    maxCallbackGasLimit: read.maxCallbackGasLimit?.toString() ?? null,
    refundExecutionFeeGasLimit:
      read.refundExecutionFeeGasLimit?.toString() ?? null,
    nativeTokenTransferGasLimit:
      read.nativeTokenTransferGasLimit?.toString() ?? null,
    ...(read.error !== undefined ? { error: read.error } : {}),
  };
}

/** What to tell the operator when the deploy still gives participant code gas. */
export function gmxCallbackOpenMessage(check: GmxCallbackCheck): string {
  const values =
    check.error !== undefined
      ? `could not be read (${check.error})`
      : `are MAX_CALLBACK_GAS_LIMIT ${check.maxCallbackGasLimit} / ` +
        `REFUND_EXECUTION_FEE_GAS_LIMIT ${check.refundExecutionFeeGasLimit} / ` +
        `NATIVE_TOKEN_TRANSFER_GAS_LIMIT ${check.nativeTokenTransferGasLimit}`;
  return (
    `GMX's callback and receiver gas limits ${values}; a current deploy has all three at 0 ` +
    "(deployer/vendor/gmx-localhost.patch). The keeper refuses every order with a " +
    "callbackContract (keeper_order_refused), so no callback runs inside its transaction. A " +
    "contract receiver of an order's native ETH still runs its receive() there with " +
    "NATIVE_TOKEN_TRANSFER_GAS_LIMIT gas (enough to write state, not to trade). Re-bake to close " +
    "it: `cd deployer && npm run clean:vendors && ./scripts/setup-vendors.sh && npm run deploy -- " +
    "--keep-fresh`, then `npm run gen:local-constants` and `npm run gen:state-dump`."
  );
}

/** Read the three limits from the DataStore. */
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
    const [
      maxCallbackGasLimit,
      refundExecutionFeeGasLimit,
      nativeTokenTransferGasLimit,
    ] = await Promise.all([
      read(GMX_MAX_CALLBACK_GAS_LIMIT_KEY),
      read(GMX_REFUND_EXECUTION_FEE_GAS_LIMIT_KEY),
      read(GMX_NATIVE_TOKEN_TRANSFER_GAS_LIMIT_KEY),
    ]);
    return {
      maxCallbackGasLimit,
      refundExecutionFeeGasLimit,
      nativeTokenTransferGasLimit,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
}
