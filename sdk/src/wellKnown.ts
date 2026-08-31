// Deterministic addresses that both the environment and the agent share "by computation" (a contract so no env injection is needed).
//   - FlashArb: the address is deterministic via a fixed deployer's nonce-0 deploy (flash arb demo. GitHub #3)
// Environment-side deployment lives in core (flashArbDemo.ts).
//
// A fixed liquidation victim used to live here too, from the single-victim demo that ADR 0009 §4
// replaced. Victim addresses are seed-derived now and reach the liquidator through
// ERIS_LIQUIDATION_VICTIMS, so there is nothing left to share by computation.
import {
  getContractAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { accountAddress } from "./chain.js";

// Fixed deployer key for the demo. Since FlashArb is deployed as this key's first tx (nonce 0), the
// CREATE address is deterministic.
export const FLASH_DEPLOYER_KEY: Hex = keccak256(
  toBytes("eris-flash-arb-deployer-v1"),
);
export const FLASH_DEPLOYER_ADDRESS: Address =
  accountAddress(FLASH_DEPLOYER_KEY);

// Deterministic address of the nonce-0 deploy. Both the agent and the coordinator use this value.
export const FLASH_ARB_ADDRESS: Address = getContractAddress({
  from: FLASH_DEPLOYER_ADDRESS,
  nonce: 0n,
});
