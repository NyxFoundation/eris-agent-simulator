// Deterministic addresses that both the environment and the agent share "by computation" (a contract so no env injection is needed).
//   - FlashArb: the address is deterministic via a fixed deployer's nonce-0 deploy (flash arb demo. GitHub #3)
//   - Liquidation-demo victim: the address is known from a fixed key (GitHub #1. default value of ERIS_LIQUIDATION_VICTIMS)
// Environment-side operations such as deploy and position construction live in core (flashArbDemo.ts / liquidationDemo.ts).
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

// Fixed victim key for the liquidation demo. Because the address is known, it can be hardcoded (as
// the default) into the liquidator's env (ERIS_LIQUIDATION_VICTIMS). Being seed-independent is fine (demo-only, env-gated).
export const VICTIM_PRIVATE_KEY: Hex = keccak256(
  toBytes("eris-liquidation-victim-v1"),
);
export const VICTIM_ADDRESS: Address = accountAddress(VICTIM_PRIVATE_KEY);
