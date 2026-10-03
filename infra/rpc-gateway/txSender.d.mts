// Type declaration for the gateway's signer recovery. The gateway is plain .mjs (no build step on
// the box), so the functions the test suite imports get a declaration rather than a rewrite.
export declare function keccak256(data: Uint8Array): Buffer;
export declare function txSender(rawHex: string): string | null;
