import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { bigintToStorageWord } from "@eris/sdk/chain.js";
import { gmxOraclePriceSlots } from "@eris/sdk/protocols/gmx.js";
import { rpc, startAnvil } from "./helpers/localRpc.js";

// ADR 0011 §1: under economicGas the GMX price is written straight into MockOracleProvider's storage.
// The slots are derived from the storage layout, so pin them against a deployed mock: a price written
// at gmxOraclePriceSlots must be what getOraclePrice returns to the keeper's executeOrder.

const artifact = JSON.parse(
  readFileSync("out/MockOracleProvider.sol/MockOracleProvider.json", "utf8"),
) as { abi: unknown[]; bytecode: { object: Hex } };
// anvil's first default account; the scratch node is local to this test.
const KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as Address;

test("a price written at gmxOraclePriceSlots is the provider's oracle price", async (t) => {
  const url = await startAnvil(t);
  const publicClient = createPublicClient({ chain: foundry, transport: http(url) });
  const wallet = createWalletClient({
    chain: foundry,
    transport: http(url),
    account: privateKeyToAccount(KEY),
  });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  });
  await rpc(url, "anvil_mine");
  const mock = (await publicClient.getTransactionReceipt({ hash })).contractAddress!;

  const prices: Array<[Address, bigint]> = [
    [WETH, 3_012_345_678_901_234_567_890_000_000_000_000n],
    [WBTC, 600_000_000_000_000_000_000_000_000_000_000_000n],
  ];
  for (const [token, price] of prices) {
    const [minSlot, maxSlot, setSlot] = gmxOraclePriceSlots(token);
    for (const [slot, value] of [
      [minSlot, price],
      [maxSlot, price + 1n],
      [setSlot, 1n],
    ] as const)
      await rpc(url, "anvil_setStorageAt", [mock, slot, bigintToStorageWord(value)]);
  }
  for (const [token, price] of prices) {
    const read = (await publicClient.readContract({
      address: mock,
      abi: artifact.abi,
      functionName: "getOraclePrice",
      args: [token, "0x"],
    })) as { token: Address; min: bigint; max: bigint };
    assert.equal(read.token.toLowerCase(), token.toLowerCase());
    assert.equal(read.min, price);
    assert.equal(read.max, price + 1n);
  }
  // The struct's slots are per token: writing WBTC did not touch WETH.
  const untouched = gmxOraclePriceSlots("0x000000000000000000000000000000000000dEaD");
  assert.equal(new Set([...gmxOraclePriceSlots(WETH), ...untouched]).size, 6);
});
