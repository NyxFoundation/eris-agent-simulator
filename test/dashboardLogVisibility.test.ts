// The one rule for why an agent's decision log is absent from a dashboard page (issue #69).
//
// Two pages say it -- the agent page and the board's log panel -- and they used to derive it
// separately with opposite precedence for a self-hosted agent viewed by the audience. The reason
// matters because each is a different claim: "audience" says the server withholds every
// participant's log and pending bids while the competition runs (rules §2.6 / §7.2), "self-hosted"
// says this one was never written here. Operator-run agents in the live week are the case the
// issue was filed for: not external, yet their reasoning and bids must not reach a viewer.
import test from "node:test";
import assert from "node:assert/strict";
import { decisionLogAbsence } from "../dashboard/src/data/logVisibility.js";

test("an operator-run agent's log is withheld from the audience, with that reason", () => {
  assert.equal(decisionLogAbsence(false, true), "audience");
});

test("the audience reason wins over self-hosted: the public view withholds everyone's log", () => {
  assert.equal(decisionLogAbsence(true, true), "audience");
});

test("the operator sees a self-hosted agent's absence for what it is, and a local agent's log", () => {
  assert.equal(decisionLogAbsence(true, false), "self-hosted");
  assert.equal(decisionLogAbsence(false, false), null);
});
