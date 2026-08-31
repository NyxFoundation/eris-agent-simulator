// Priority-fee ordering: does the block builder put the higher bid first?
//
// Two modes, one question.
//
//   npm run check:ordering -- <run_dir|blocks.csv>
//     After the fact, from a run's own record. Cheap, and it covers exactly the traffic that ran.
//
//   npm run check:ordering -- --live [--rounds N] [--senders K]
//     Against a live chain, by bidding against ourselves. This is issue #35's "sequencer ordering
//     verification", and it exists because the default profile's whole design rests on the answer:
//     the environment lands its oracle update at txIndex 0 by outbidding every agent, so an oracle
//     that can be front-run is an oracle agents can trade against. anvil guarantees this with
//     `--order fees`. op-geth is *documented* to build in effective-tip order, and #35 calls that
//     the load-bearing assumption -- assumptions that carry a design get measured.
//
// The live probe sends its bids in *ascending* fee order, so arrival order and fee order disagree.
// A builder that simply keeps txs in the order they arrived would pass a descending-order probe and
// fail this one, which is the difference between measuring the property and confirming a coincidence.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bootstrapCliEnv } from "./bootstrapEnv.js";
import {
  accountAddress,
  fundWallet,
  makeClients,
  setChainMode,
} from "@eris/sdk/chain.js";
import { parseCliFlags, resolveRunInputs } from "../runConfig.js";

// The live probe funds its bidders through the run's own funding path, which resolves token
// addresses from the deployment. Nothing here reads a venue, but the env has to be settled before
// the config is (see bootstrapEnv); the csv path ignores all of it.
bootstrapCliEnv();

type BlockRow = {
  round: number;
  blockNumber: string;
  txIndex: number;
  priorityFeeWei: bigint;
  hash: string;
  ownerId: string;
};

const flags = parseCliFlags(process.argv);

function runCsvCheck(): void {
  const input = process.argv[2];
  if (!input) {
    console.error(
      "Usage: npm run check:ordering -- <run_dir|blocks.csv>\n" +
        "       npm run check:ordering -- --live [--rounds N] [--senders K] [--config <path>]",
    );
    process.exit(1);
  }

  const csvPath = input.endsWith(".csv") ? input : join(input, "blocks.csv");
  if (!existsSync(csvPath)) {
    console.error(`Missing blocks.csv: ${csvPath}`);
    process.exit(1);
  }

  const rows = parseBlocksCsv(readFileSync(csvPath, "utf8"));
  const failures = checkOrdering(rows);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  console.log(`priority fee ordering ok: ${rows.length} tx rows checked`);
}

// ---------------------------------------------------------------------------
// live probe (issue #35)
// ---------------------------------------------------------------------------

// A bare value transfer to self: 21,000 gas, no state to read back, and nothing that could revert
// for a reason unrelated to ordering.
const PROBE_GAS = 21_000n;

type ProbeTx = { hash: Hex; sender: Address; bidWei: bigint };

async function runLiveProbe(): Promise<void> {
  const rounds = Math.max(1, Number(flags.rounds ?? 5));
  const senders = Math.max(2, Number(flags.senders ?? 6));
  const { config } = resolveRunInputs(process.argv);
  setChainMode(config.chainMode, config.treasuryPrivateKey);
  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
  );

  // Independent senders, because one account's txs are ordered by nonce whatever the builder does:
  // a single-sender probe cannot tell fee ordering from nonce ordering.
  const keys: Hex[] = Array.from({ length: senders }, (_, i) =>
    keccak256(stringToBytes(`ordering-probe:${config.seed}:${i}`)),
  );
  const addresses = keys.map(accountAddress);

  console.error(
    `[ordering] ${config.chainMode} chain at ${config.rpcUrl} (chainId ${config.chainId}); ` +
      `${rounds} round(s) x ${senders} bidders`,
  );

  // Enough for the probe txs plus the funding transfer itself. No tokens, no WETH: the probe never
  // touches a venue.
  for (const key of keys) {
    await fundWallet(
      publicClient,
      walletClient,
      chain,
      key,
      10_000_000_000_000_000n * BigInt(rounds + 2),
      0n,
      0n,
      undefined,
      0n,
    );
  }

  let inversions = 0;
  let compared = 0;
  const perRound: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const head = await publicClient.getBlock();
    const baseFee = head.baseFeePerGas ?? 0n;
    // Ascending bids in submission order. The lowest bid arrives first, so "arrived first" and
    // "bid most" point in opposite directions and only one of them can explain the result.
    const bids = Array.from(
      { length: senders },
      (_, i) => 1_000_000_000n * BigInt(i + 1),
    );
    const sent: ProbeTx[] = [];
    for (let i = 0; i < senders; i++) {
      const hash = await walletClient.sendTransaction({
        account: privateKeyToAccount(keys[i]),
        chain,
        to: addresses[i],
        value: 0n,
        gas: PROBE_GAS,
        maxFeePerGas: baseFee * 2n + bids[i],
        maxPriorityFeePerGas: bids[i],
      });
      sent.push({ hash, sender: addresses[i], bidWei: bids[i] });
    }

    const receipts = await Promise.all(
      sent.map((tx) =>
        publicClient.waitForTransactionReceipt({
          hash: tx.hash,
          timeout: 120_000,
        }),
      ),
    );

    // Only txs that shared a block can be compared: two blocks are two auctions.
    const byBlock = new Map<string, Array<ProbeTx & { txIndex: number }>>();
    receipts.forEach((receipt, i) => {
      const key = receipt.blockNumber.toString();
      const list = byBlock.get(key) ?? [];
      list.push({ ...sent[i], txIndex: receipt.transactionIndex });
      byBlock.set(key, list);
    });

    let roundInversions = 0;
    let roundCompared = 0;
    for (const [blockNumber, list] of byBlock) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.txIndex - b.txIndex);
      for (let i = 1; i < list.length; i++) {
        roundCompared++;
        if (list[i - 1].bidWei >= list[i].bidWei) continue;
        roundInversions++;
        console.error(
          `[ordering] block ${blockNumber}: txIndex ${list[i - 1].txIndex} bid ` +
            `${list[i - 1].bidWei} came before txIndex ${list[i].txIndex} bid ${list[i].bidWei}`,
        );
      }
    }
    inversions += roundInversions;
    compared += roundCompared;
    const spread = [...byBlock.keys()].length;
    perRound.push(
      `round ${round + 1}: ${sent.length} bids across ${spread} block(s), ` +
        `${roundCompared} adjacent pair(s), ${roundInversions} inversion(s)`,
    );
  }

  for (const line of perRound) console.error(`[ordering] ${line}`);
  if (compared === 0) {
    // Not a pass. Every probe tx landing in its own block means the chain never had two bids to
    // choose between, so the property was never exercised -- reporting "ok" here would record a
    // verification that did not happen (the block time is likely shorter than a round trip).
    console.error(
      "[ordering] INCONCLUSIVE: no two probe txs shared a block, so nothing was ordered. " +
        "Raise --senders, or run against a chain whose block time exceeds the submission round trip.",
    );
    process.exit(2);
  }
  if (inversions > 0) {
    console.error(
      `[ordering] FAIL: ${inversions}/${compared} adjacent pairs were out of fee order. ` +
        "The default profile puts the oracle update at txIndex 0 by outbidding the field " +
        "(ADR 0010); on this chain that does not hold, and the environment's price becomes " +
        "front-runnable (issue #35 / issue #33 (2)).",
    );
    process.exit(1);
  }
  console.log(
    `priority fee ordering ok on a live ${config.chainMode} chain: ` +
      `${compared} adjacent in-block pair(s) across ${rounds} round(s), 0 inversions`,
  );
}

function parseBlocksCsv(csv: string): BlockRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const header = lines[0].split(",");
  const required = [
    "round",
    "blockNumber",
    "txIndex",
    "hash",
    "priorityFeeWei",
    "ownerId",
  ];
  for (const column of required) {
    if (!header.includes(column))
      throw new Error(`blocks.csv missing required column: ${column}`);
  }

  return lines
    .slice(1)
    .map((line) => {
      const values = line.split(",");
      const row = Object.fromEntries(
        header.map((column, columnIndex) => [
          column,
          values[columnIndex] ?? "",
        ]),
      );
      return {
        round: Number(row.round),
        blockNumber: row.blockNumber,
        txIndex: Number(row.txIndex),
        priorityFeeWei: BigInt(row.priorityFeeWei),
        hash: row.hash,
        ownerId: row.ownerId,
      };
    })
    .sort(
      (a, b) =>
        a.round - b.round ||
        Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
        a.txIndex - b.txIndex,
    );
}

function checkOrdering(rows: BlockRow[]): string[] {
  const failures: string[] = [];
  const grouped = new Map<string, BlockRow[]>();
  for (const row of rows) {
    const key = `${row.round}:${row.blockNumber}`;
    const blockRows = grouped.get(key) ?? [];
    blockRows.push(row);
    grouped.set(key, blockRows);
  }

  for (const [key, blockRows] of grouped) {
    blockRows.sort((a, b) => a.txIndex - b.txIndex);
    for (let i = 1; i < blockRows.length; i++) {
      const previous = blockRows[i - 1];
      const current = blockRows[i];
      if (
        previous.priorityFeeWei < current.priorityFeeWei &&
        previous.ownerId !== current.ownerId
      ) {
        failures.push(
          `priority fee ordering violation in ${key}: txIndex ${previous.txIndex} ${previous.ownerId} ${previous.priorityFeeWei} < txIndex ${current.txIndex} ${current.ownerId} ${current.priorityFeeWei}`,
        );
      }
    }
  }
  return failures;
}

// Last, not first: the live probe reads module constants declared above it, and a top-level `await`
// placed before them runs while they are still in the temporal dead zone.
if (flags.live) await runLiveProbe();
else runCsvCheck();
