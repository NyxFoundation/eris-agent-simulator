// The world map is the only view that has to put a transaction on a *node*, so it carries its own
// action -> venue table (dashboard/src/data/worldVenues.ts). That table cannot import the sdk's
// vocabulary: `ACTION_TYPES_BY_PROTOCOL` lives in sdk/src/action.ts, which pulls in the protocol
// adapters and viem, and the dashboard's copy runs in a browser.
//
// So it is a copy, and this is what stops it drifting. Add an action to the vocabulary without
// telling the map about it and the transaction would be drawn reaching the chain and stopping —
// mined, and apparently touching nothing. That is a wrong picture, not a missing one, which is why
// it fails here rather than degrading quietly.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_TYPES_BY_PROTOCOL } from "@eris/sdk/action.js";
import {
  VENUE_BY_ACTION,
  WORLD_VENUES,
  venueOfTx,
} from "../dashboard/src/data/worldVenues.js";

test("every action type in the vocabulary maps to its own protocol's node", () => {
  for (const [protocol, actions] of Object.entries(ACTION_TYPES_BY_PROTOCOL)) {
    for (const action of actions) {
      assert.equal(
        VENUE_BY_ACTION[action],
        protocol,
        `${action} is a ${protocol} action; the world map maps it to ${VENUE_BY_ACTION[action] ?? "nothing"}`,
      );
    }
  }
});

test("the map draws no node the venue table does not define", () => {
  for (const venue of Object.values(VENUE_BY_ACTION))
    assert.ok(venue in WORLD_VENUES, `${venue} has no node on the map`);
});

test("every protocol that has actions has a node", () => {
  for (const protocol of Object.keys(ACTION_TYPES_BY_PROTOCOL))
    assert.ok(protocol in WORLD_VENUES, `${protocol} has no node on the map`);
});

test("the sender's own report of the venue wins over the decoded function name", () => {
  // `swap` is Uniswap's action and Balancer's Vault function. A transaction that says which venue
  // it went to is not overruled by a name that is ambiguous across two of them.
  assert.equal(
    venueOfTx({ protocol: "balancer", actionType: "swap", method: "swap" }),
    "balancer",
  );
  assert.equal(venueOfTx({ actionType: "swap" }), "uniswap");
});

test("a name that does not resolve to one venue resolves to none", () => {
  // `deposit` is the WETH wrap and the LST vault's stake; `withdraw` is the unwrap and Aave's.
  // Guessing would put a transaction on a contract it never touched.
  assert.equal(venueOfTx({ method: "deposit" }), null);
  assert.equal(venueOfTx({ method: "withdraw" }), null);
  assert.equal(venueOfTx({}), null);
  assert.equal(venueOfTx({ protocol: "not-a-venue" }), null);
});
