// 環境と agent の双方が「計算で」共有する決定論アドレス（env 注入不要にするための契約）。
//   - FlashArb: 固定 deployer の nonce-0 デプロイでアドレスを決定論化（フラッシュ arb デモ。GitHub #3）
//   - 清算デモ victim: 固定鍵でアドレス既知（GitHub #1。ERIS_LIQUIDATION_VICTIMS の既定値）
// デプロイやポジション構築など環境側の操作は core（flashArbDemo.ts / liquidationDemo.ts）にある。
import {
  getContractAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { accountAddress } from "./chain.js";

// デモ用の固定 deployer 鍵。FlashArb をこの鍵の最初の tx(nonce 0)としてデプロイするため、
// CREATE アドレスが決定論的になる。
export const FLASH_DEPLOYER_KEY: Hex = keccak256(
  toBytes("eris-flash-arb-deployer-v1"),
);
export const FLASH_DEPLOYER_ADDRESS: Address =
  accountAddress(FLASH_DEPLOYER_KEY);

// nonce 0 デプロイの決定論アドレス。agent も coordinator もこの値を使う。
export const FLASH_ARB_ADDRESS: Address = getContractAddress({
  from: FLASH_DEPLOYER_ADDRESS,
  nonce: 0n,
});

// 清算デモ用の固定 victim 鍵。アドレスが既知なので liquidator の env(ERIS_LIQUIDATION_VICTIMS)に
// ハードコード(既定値)できる。seed 非依存でよい(デモ専用・env gate 済み)。
export const VICTIM_PRIVATE_KEY: Hex = keccak256(
  toBytes("eris-liquidation-victim-v1"),
);
export const VICTIM_ADDRESS: Address = accountAddress(VICTIM_PRIVATE_KEY);
