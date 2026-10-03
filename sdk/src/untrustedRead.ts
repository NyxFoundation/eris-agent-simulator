// Reads that execute participant-deployed code (issue #213).
//
// Every other read in the sdk runs environment code: a venue the deployer compiled, whose cost is
// known. A read of a lending market's oracle, or the ERC-20 probe of a contract somebody just
// deployed, runs whatever that participant compiled -- and `eth_call` without a `gas` field runs it
// with the node's default budget, the block gas limit (30,000,000). One contract that loops then
// burns the whole budget on every read, every block, for every reader: measured on anvil 1.7.1, a
// keccak loop costs ~280 ms per uncapped call and ~3 ms capped at 200,000 (PR for #213).
//
// Three rules, all of them here so that no caller has to remember them:
//
//   1. **One `eth_call` per target, with an explicit `gas`, never through Multicall3.** The
//      aggregate forwards 63/64 of what is left to each inner CALL, so one looping target would
//      starve every target listed after it in the same batch -- an honest oracle reads as missing
//      because a trap happened to be listed first. With the transport's JSON-RPC batching the
//      individual calls still travel in one HTTP request, and viem routes a call that carries
//      `gas` around its own multicall aggregation (`shouldPerformMulticall` is false for it).
//
//   2. **A read that fails is `undefined`, never zero.** Out of gas, revert, no code, timeout --
//      all of them are "could not read", the shape the LST and Aave adapters already use. A zero
//      price would mark every borrower liquidatable; a zero owner would say "nobody can move this
//      oracle". The failure kind rides along for the one reader that reports it (the coordinator's
//      registry sweep), and `revert` is the ordinary answer of a contract that is simply not a
//      token, so a reporter should not treat it as news.
//
//   3. **The batch has a wall-clock deadline, and no retries.** The gas cap is the node's to
//      enforce; the deadline is the backstop for a node that is slow for any other reason, so that
//      neither an agent's observation nor the coordinator's block tick waits on the transport's
//      120-second timeout for a value it is allowed to go without. A read past the deadline is
//      `timeout`, and the in-flight request is left to settle on its own. Retries are off because
//      anvil answers out-of-gas as a JSON-RPC *internal* error (-32603), which viem's transport
//      retries with backoff: measured, one looping oracle cost ~450 ms of waiting per read on a
//      3 ms cap, two extra node calls, and the deadline. The answer does not change on a retry.
import type { Abi, Address, PublicClient } from "viem";

// Per read. The same number the lending singleton gives an oracle or IRM it `staticcall`s
// (`contracts/SimpleLending.sol` `EXTERNAL_CALL_GAS`), so a price the singleton can read, the
// observation can read too -- and one it cannot, nobody can. A real `owner()` / `price()` /
// `decimals()` costs a few thousand gas; this is two orders of magnitude of headroom, not a budget
// to compute in.
export const UNTRUSTED_READ_GAS = 200_000n;

// Per simulated trade that passes through participant code -- a QuoterV2 quote of a launch pool
// executes the token's `transfer` inside the pool's swap. A Uniswap V3 swap that crosses a few
// ticks costs a few hundred thousand gas; one that needs more than this is a trade whose real
// transaction would cost the same, which is not a trade worth sending either.
export const UNTRUSTED_SIMULATION_GAS = 2_000_000n;

// Wall clock for one batch of untrusted reads. Half the block interval: the observation and the
// coordinator's tick both have a two-second budget for *everything*, and an untrusted value is the
// one thing in it that may be left out.
export const UNTRUSTED_READ_TIMEOUT_MS = 1_000;

export type UntrustedRead = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

// Why a read has no value. `revert` is a contract declining to answer (the normal case for a
// non-token asked `name()`); `out-of-gas` is one that could not answer within the cap; `timeout` is
// the node not answering in time; `error` is everything else (transport, decoding).
export type UntrustedReadFailure = "out-of-gas" | "revert" | "timeout" | "error";

export type UntrustedReadResult =
  | { value: unknown; failure?: undefined }
  | { value: undefined; failure: UntrustedReadFailure; message: string };

export type UntrustedReadOptions = {
  blockNumber?: bigint;
  // Default UNTRUSTED_READ_TIMEOUT_MS. Zero disables the deadline.
  timeoutMs?: number;
  // Default UNTRUSTED_READ_GAS.
  gas?: bigint;
};

const TIMEOUT = Symbol("untrusted-read-timeout");

function errorText(error: unknown): string {
  if (error instanceof Error) {
    // viem puts the node's message in `details` and a generic one in `message`.
    const details = (error as { details?: unknown }).details;
    return `${error.name}: ${error.message}${typeof details === "string" ? ` ${details}` : ""}`;
  }
  return String(error);
}

export function classifyReadError(error: unknown): UntrustedReadFailure {
  if (error === TIMEOUT) return "timeout";
  const text = errorText(error);
  // anvil: `EVM error OutOfGas`; geth-style clients: `out of gas`.
  if (/out ?of ?gas/i.test(text)) return "out-of-gas";
  if (
    /revert/i.test(text) ||
    // viem's names for "the call succeeded with no data" / "it reverted without a reason", which
    // is what an address without the function (or without code) answers.
    /ContractFunctionZeroDataError|ContractFunctionRevertedError|returned no data/i.test(
      text,
    )
  )
    return "revert";
  return "error";
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

// The node's own words when viem kept them (`details`); viem's summary otherwise. The summary
// for an out-of-gas answer reads "reverted with the following reason:", which is not what happened.
function failureMessage(error: unknown): string {
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details === "string" && details.length > 0) return firstLine(details);
  return firstLine(errorText(error));
}

/** One `eth_call` of participant code, gas-capped. See the module comment for the rules. */
export async function readUntrusted(
  publicClient: PublicClient,
  read: UntrustedRead,
  opts: UntrustedReadOptions = {},
): Promise<UntrustedReadResult> {
  const [result] = await readUntrustedBatch(publicClient, [read], opts);
  return result;
}

/** The batch form: one `eth_call` each, in parallel, under one wall-clock deadline. */
export async function readUntrustedBatch(
  publicClient: PublicClient,
  reads: readonly UntrustedRead[],
  opts: UntrustedReadOptions = {},
): Promise<UntrustedReadResult[]> {
  if (reads.length === 0) return [];
  const gas = opts.gas ?? UNTRUSTED_READ_GAS;
  const timeoutMs = opts.timeoutMs ?? UNTRUSTED_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    timeoutMs > 0
      ? new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        })
      : undefined;
  const one = async (read: UntrustedRead): Promise<UntrustedReadResult> => {
    const call = publicClient.readContract({
      address: read.address,
      abi: read.abi as Abi,
      functionName: read.functionName,
      args: read.args as never,
      gas,
      requestOptions: { retryCount: 0 },
      ...(opts.blockNumber === undefined ? {} : { blockNumber: opts.blockNumber }),
    } as never) as Promise<unknown>;
    try {
      const value = deadline ? await Promise.race([call, deadline]) : await call;
      if (value === TIMEOUT) {
        // The request is still in flight; let it settle quietly rather than reject unhandled.
        call.catch(() => undefined);
        return {
          value: undefined,
          failure: "timeout",
          message: `no answer within ${timeoutMs} ms`,
        };
      }
      return { value };
    } catch (error) {
      return {
        value: undefined,
        failure: classifyReadError(error),
        message: failureMessage(error),
      };
    }
  };
  try {
    return await Promise.all(reads.map(one));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
