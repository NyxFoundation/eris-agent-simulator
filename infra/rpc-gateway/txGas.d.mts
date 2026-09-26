// Type declaration for the gateway's gas reader (issue #40 T0). The gateway is plain .mjs — it runs
// on the box with no build step — so the functions the test suite imports get a declaration
// rather than a rewrite.
export declare function txGasLimit(rawHex: string): bigint | null;

export type TxFees =
  | { type: number; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gasPrice?: undefined }
  | { type: number; gasPrice: bigint; maxPriorityFeePerGas?: undefined; maxFeePerGas?: undefined };
export declare function txFees(rawHex: string): TxFees | null;
export declare function feeRuleViolation(
  fees: TxFees,
  capWei: bigint,
): { kind: "max_fee_above_tip" | "over_cap"; message: string } | null;
