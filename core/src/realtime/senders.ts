// The registered field, written out for the RPC gateway's sender check (infra/rpc-gateway).
//
// The gateway refuses a raw transaction whose signer is not bound to the caller's X-ASCON-Key. The
// binding used to be a second list the operator kept by hand (`issue-key.sh --bind`), next to the
// registrations file that already says which address belongs to which participant. Two lists of the
// same thing drift, and on a period where participants register throughout, the drift is a
// participant whose every submission is 403 until someone notices. So the coordinator -- which
// already reads the registrations, refuses duplicates and knows the startup roster's external
// entries -- writes the field it accepted, and the gateway reads that.
//
// The gateway matches on the key's participant id. Here that is `participant` when the entry states
// it (rules §2.2: one unit, possibly several agents, one key) and the agent id otherwise, so the key
// is issued under the same name (`issue-key.sh --issue <name>`).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SenderAgent = {
  id: string;
  address: string;
  external: boolean;
  participant?: string;
};

export type SendersDocument = {
  note: string;
  updatedAt: string;
  senders: Record<string, string[]>;
};

/**
 * Participant id -> lowercase addresses, for every external agent. Agents the coordinator runs are
 * left out: they talk to the node directly and never pass the gateway, and listing them would let a
 * key named like one of them send from its wallet.
 */
export function sendersDocument(
  agents: readonly SenderAgent[],
  now = new Date(),
): SendersDocument {
  const senders: Record<string, string[]> = {};
  for (const a of agents) {
    if (!a.external) continue;
    const unit = a.participant ?? a.id;
    const address = a.address.toLowerCase();
    const list = (senders[unit] ??= []);
    if (!list.includes(address)) list.push(address);
  }
  return {
    note: "Written by the coordinator (run.sendersFile): participant id -> addresses its X-ASCON-Key may send from.",
    updatedAt: now.toISOString(),
    senders,
  };
}

/**
 * Write atomically (temp file + rename): the gateway re-reads on mtime, and a half-written file
 * would be read as a parse failure -- harmless, since it keeps the previous bindings, but noisy.
 * The gateway mounts the directory, not the file, so the rename is visible inside its container.
 */
export function writeSendersFile(path: string, doc: SendersDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 1) + "\n");
  renameSync(tmp, path);
}
