// External registrations the coordinator picks up while the run is going (ADR 0021 §2, rules §2.7).
//
// The roster is read once, at startup. On the trial devnet that is the wrong cadence: the chain runs
// from 9/23 to 10/31 and participants register throughout, and the only way to add one used to be
// a restart -- which opens a new competition directory and splits the standings in two. So a second
// list exists (`run.registrationsFile`), re-read during the mining loop. An entry has the same shape
// as an `external: true` + `address` roster entry, because it is the same registration; only the
// moment it is read differs.
//
// Pure. Parsing and de-duplication live here so they can be tested without a coordinator; what the
// coordinator does with a new entry (fund it, attribute its txs, score it from the next boundary,
// republish the roster) is its wiring, kept small on purpose.
import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Address } from "viem";

export type Registration = {
  id: string;
  address: Address;
  /** Rules §2.2: the participant unit this agent is one submission of. */
  participant?: string;
  description?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Fields that describe how to *start* something. Refused for the same reason the roster refuses them
// on an external entry (core/src/config.ts): a registration that silently kept a `command` would
// read as if the operator were running the agent.
const SPAWN_FIELDS = ["wallet", "command", "args", "dir", "env"] as const;

/**
 * Parse the registrations file. YAML or JSON (JSON is YAML 1.2, so one parser reads both), in any
 * of three shapes: a bare list, `{ agents: [...] }` (so a roster file can be reused verbatim), or
 * `{ registrations: [...] }`. An empty file is an empty list -- the operator creates it before the
 * first participant arrives.
 */
export function parseRegistrations(text: string, path: string): Registration[] {
  if (text.trim() === "") return [];
  const doc: unknown = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  let list: unknown;
  if (Array.isArray(doc)) list = doc;
  else if (doc && typeof doc === "object") {
    const o = doc as Record<string, unknown>;
    list = o.registrations ?? o.agents;
    if (list === undefined)
      throw new Error(
        `${path} must be a list of registrations, or a mapping with a "registrations" (or "agents") list`,
      );
  } else throw new Error(`${path} must be a list of registrations`);
  if (!Array.isArray(list))
    throw new Error(`${path}: "registrations" must be a list`);

  return list.map((entry, index) => {
    const label = `${path} [${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${label} must be a mapping`);
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "")
      throw new Error(`${label}.id must be a non-empty string`);
    if (typeof e.address !== "string" || !ADDRESS_RE.test(e.address))
      throw new Error(
        `${label}.address must be a 0x-prefixed 20-byte hex address (the participant's own; ` +
          "the environment holds no key for a registration)",
      );
    // `external: true` is implied and may be written; `external: false` is a contradiction.
    if (e.external !== undefined && e.external !== true)
      throw new Error(
        `${label}.external must be true when present: every registration is a participant ` +
          "running their own agent (ADR 0021 §2)",
      );
    for (const key of SPAWN_FIELDS)
      if (e[key] !== undefined)
        throw new Error(
          `${label}.${key} has no meaning for a registration: the participant runs the agent on ` +
            "their own machine, so the environment never spawns anything (ADR 0021 §2)",
        );
    if (
      e.participant !== undefined &&
      (typeof e.participant !== "string" || e.participant.trim() === "")
    )
      throw new Error(
        `${label}.participant must be a non-empty string when present (rules §2.2)`,
      );
    if (e.description !== undefined && typeof e.description !== "string")
      throw new Error(`${label}.description must be a string when present`);
    return {
      id: e.id,
      address: e.address as Address,
      ...(e.participant !== undefined ? { participant: e.participant } : {}),
      ...(e.description !== undefined ? { description: e.description } : {}),
    };
  });
}

/** What the run already knows: agent ids, and every address it attributes (lowercase -> owner id). */
export type KnownField = {
  ids: ReadonlySet<string>;
  addresses: ReadonlyMap<string, string>;
};

export type RegistrationDiff = {
  added: Registration[];
  /** Entries left out, each with the reason -- reported as a warning, never fatal. */
  ignored: Array<{ id: string; address: string; reason: string }>;
};

/**
 * Which entries are new. An entry already registered under the same id *and* address is a no-op
 * without comment (the file legitimately repeats what the roster had at startup). An id or address
 * that is already taken by something else is ignored with a reason: an address can only be one
 * agent, and a registration is not how an existing agent moves to a new key.
 */
export function diffRegistrations(
  entries: readonly Registration[],
  known: KnownField,
): RegistrationDiff {
  const added: Registration[] = [];
  const ignored: RegistrationDiff["ignored"] = [];
  const seenIds = new Set<string>();
  const seenAddresses = new Set<string>();
  for (const entry of entries) {
    const lower = entry.address.toLowerCase();
    const ownerOfAddress = known.addresses.get(lower);
    if (seenIds.has(entry.id) || seenAddresses.has(lower)) {
      ignored.push({
        id: entry.id,
        address: entry.address,
        reason: "duplicate within the registrations file",
      });
      continue;
    }
    seenIds.add(entry.id);
    seenAddresses.add(lower);
    if (known.ids.has(entry.id) && ownerOfAddress === entry.id) continue; // already registered
    if (known.ids.has(entry.id)) {
      ignored.push({
        id: entry.id,
        address: entry.address,
        reason: `id "${entry.id}" is already registered to a different address`,
      });
      continue;
    }
    if (ownerOfAddress !== undefined) {
      ignored.push({
        id: entry.id,
        address: entry.address,
        reason: `address already belongs to "${ownerOfAddress}"`,
      });
      continue;
    }
    added.push(entry);
  }
  return { added, ignored };
}

export type RegistrationsRead =
  | { kind: "missing" }
  | { kind: "unchanged" }
  | { kind: "changed"; entries: Registration[] };

/**
 * Re-reads the file only when it changed on disk. Polled every few dozen blocks for weeks, so the
 * common case has to be a `stat` and nothing else; and a malformed file is reported once per edit
 * rather than once per poll, because the mtime is taken before the parse is attempted.
 */
export class RegistrationsWatcher {
  private lastMtimeMs = -1;
  private lastSize = -1;

  constructor(readonly path: string) {}

  read(): RegistrationsRead {
    if (!existsSync(this.path)) {
      // Forget the last read, so a file that is deleted and recreated is read again.
      this.lastMtimeMs = -1;
      this.lastSize = -1;
      return { kind: "missing" };
    }
    const st = statSync(this.path);
    if (st.mtimeMs === this.lastMtimeMs && st.size === this.lastSize)
      return { kind: "unchanged" };
    this.lastMtimeMs = st.mtimeMs;
    this.lastSize = st.size;
    return {
      kind: "changed",
      entries: parseRegistrations(readFileSync(this.path, "utf8"), this.path),
    };
  }
}
