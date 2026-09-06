// Type declaration for the gateway's gas reader (issue #40 T0). The gateway is plain .mjs — it runs
// on the box with no build step — so the one function the test suite imports gets a declaration
// rather than a rewrite.
export declare function txGasLimit(rawHex: string): bigint | null;
