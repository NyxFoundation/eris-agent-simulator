// The action vocabulary handed to the self-improvement model (ADR 0018) has to name actions that
// actually exist. A name that drifted is worse than a missing one: the model writes a strategy
// around it, the action is rejected before installation, and what shows up in the log is a revision
// that "failed to compile" rather than a stale prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_TYPES_BY_PROTOCOL } from "../sdk/src/action.js";
import { initProtocols } from "../sdk/src/protocols/registry.js";
import type { ProtocolId } from "../sdk/src/types.js";

const ALL: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "gmx",
  "aave",
  "lst",
  "liquity",
];

test("every action type in the vocabulary is owned by its protocol's adapter", () => {
  const adapters = initProtocols(ALL);
  for (const id of ALL) {
    const adapter = adapters.find((a) => a.id === id);
    assert.ok(adapter, `no adapter for ${id}`);
    for (const type of ACTION_TYPES_BY_PROTOCOL[id]) {
      // parse() is the adapter's own answer to "is this mine", and it has two ways of saying yes:
      // return the parsed action, or throw about a missing field. Only `null` means "not my type",
      // which is exactly what a renamed or removed action looks like. The probe passes no fields on
      // purpose -- this checks the vocabulary, not the field schemas.
      let owned: boolean;
      try {
        owned = adapter.parse({ type }) !== null;
      } catch {
        owned = true;
      }
      assert.ok(
        owned,
        `${id} no longer owns "${type}" — update ACTION_TYPES_BY_PROTOCOL in sdk/src/action.ts`,
      );
    }
  }
});

test("no protocol is missing from the vocabulary", () => {
  // A venue added without a vocabulary entry is invisible to the model: it can observe the venue and
  // never learn what to call the actions on it.
  for (const id of ALL)
    assert.ok(
      ACTION_TYPES_BY_PROTOCOL[id]?.length > 0,
      `${id} has no action types listed`,
    );
});
