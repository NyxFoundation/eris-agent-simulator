// Deploying a contract from a strategy (issue #40 T5).
//
// Deployment goes through the ordinary action path — a `rawTx` with no `to`, whose `data` is the
// creation bytecode — rather than through a second signer. The runtime owns the nonce, the per-block
// transaction cap and the gas budget; a strategy that signed its own deploys would be a second
// sender on the same key, and two senders on one key race on the nonce (which is how the LST
// redemption rate once froze for a whole run).
//
// The artifact comes from the forge output shipped in the submission bundle, read through the sdk's
// single reader (`ERIS_FORGE_OUT` overrides the directory when the bundle's layout differs).
import {
  encodeAbiParameters,
  encodeDeployData,
  getContractAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readForgeArtifact } from "@eris/sdk/forge.js";

export type DeployAction = {
  type: "rawTx";
  tx: { data: Hex };
  reason?: string;
  maxPriorityFeePerGasWei?: string;
};

// A deployment action for `out/<name>.sol/<name>.json` with the given constructor arguments.
export function deployAction(
  name: string,
  args: readonly unknown[] = [],
  opts: { reason?: string; maxPriorityFeePerGasWei?: string } = {},
): DeployAction {
  const { abi, bytecode } = readForgeArtifact(name);
  return {
    type: "rawTx",
    tx: {
      data: encodeDeployData({ abi, bytecode, args: args as never }),
    },
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.maxPriorityFeePerGasWei
      ? { maxPriorityFeePerGasWei: opts.maxPriorityFeePerGasWei }
      : {}),
  };
}

export function artifactAbi(name: string): Abi {
  return readForgeArtifact(name).abi;
}

// Where a deploy from `self` at `nonce` lands. Exported because the caller usually wants to look at
// the address before deciding it is the right one.
export function deployAddressFor(self: Address, nonce: number): Address {
  return getContractAddress({ from: self, nonce: BigInt(nonce) });
}

// Find the contract a recent deploy produced.
//
// The runtime allocates the nonce, so a strategy cannot know it in advance; instead it scans the
// small window of nonces around what it has sent and takes the ones that now hold code. Scanning is
// the honest way round: the alternative is waiting for the registry, and the creator is supposed to
// know about its own contract *before* the registry publishes it — that one-block head start is the
// incentive to build.
export async function findDeployedContracts(
  publicClient: PublicClient,
  self: Address,
  opts: { fromNonce: number; toNonce: number },
): Promise<Address[]> {
  const out: Address[] = [];
  for (let nonce = opts.fromNonce; nonce <= opts.toNonce; nonce++) {
    const address = deployAddressFor(self, nonce);
    try {
      const code = await publicClient.getCode({ address });
      if (code && code.length > 2) out.push(address);
    } catch {
      // A read that failed is not a contract that is not there; skip and let the next block retry.
    }
  }
  return out;
}

// The agent's nonce right now, for bracketing the scan above.
export async function currentNonce(
  publicClient: PublicClient,
  self: Address,
): Promise<number> {
  return publicClient.getTransactionCount({ address: self, blockTag: "pending" });
}

export { encodeAbiParameters };
