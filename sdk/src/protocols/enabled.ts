// The run's enabled protocol ids, readable from an adapter without importing the registry.
//
// registry.ts imports every adapter, so an adapter importing it back is a cycle. This tiny module
// owns the state instead: the registry writes it in setEnabledProtocols, adapters read it. It
// exists because a venue must be able to ask "did this run enable me?" — answering from the
// deployment alone makes a disabled venue change the behaviour of an enabled one (issue #38).
import type { ProtocolId } from "../types.js";

let enabled: ProtocolId[] = [];

export function setEnabledProtocolIds(ids: ProtocolId[]): void {
  enabled = [...ids];
}

export function enabledProtocolIds(): readonly ProtocolId[] {
  return enabled;
}
