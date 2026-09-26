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
//
// It then asks a second question the first cannot: *which field* is the bid. Every tx in the
// ascending probe signs maxFeePerGas equal to its tip, so a builder sorting on maxFeePerGas and one
// sorting on the tip produce the same order there. They do not agree once the two fields differ, and
// anvil sorts on maxFeePerGas (foundry v1.7.1, crates/anvil/src/eth/pool/transactions.rs:
// `TransactionPriority(tx.max_fee_per_gas())`) while, at base fee 0, a tx pays min(maxFeePerGas, tip).
// Measured 2026-09-27 on anvil 1.7.1 `--order fees --base-fee 0`: a tx paying 0.1 gwei with
// maxFeePerGas 7 gwei landed at txIndex 0, ahead of a 6 gwei/6 gwei tx shaped like the oracle
// update. So the key probe pairs an honest bid (maxFee = tip) with an overbid (tip lower, maxFee
// higher) and reports which one the builder put first. On a builder that sorts on maxFeePerGas the
// participant rule "maxFeePerGas <= maxPriorityFeePerGas" (RPC gateway, runtime, postRunCheck) is
// what keeps the order equal to what was paid -- the probe says whether that rule is load-bearing.
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
import { classifyOrderingKey, type KeyProbePair } from "../orderingKey.js";

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
        // maxFeePerGas = maxPriorityFeePerGas: the shape the participant rule requires, so the
        // ascending probe measures fee order and nothing else (the key probe below is the one that
        // pulls the two fields apart).
        maxFeePerGas: baseFee + bids[i],
        maxPriorityFeePerGas: baseFee + bids[i],
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

  const key = await probeOrderingKey(
    publicClient,
    walletClient,
    chain,
    [keys[0], keys[1]],
    rounds,
  );
  console.error(`[ordering] key probe: ${key.summary}`);
  for (const line of key.lines) console.error(`[ordering]   ${line}`);

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
      `${compared} adjacent in-block pair(s) across ${rounds} round(s), 0 inversions; ` +
      `key probe: ${key.verdict}`,
  );
}

// The key probe (see the header). One honest bid and one overbid per round, from two independent
// senders, sent back to back so they share a block. Arrival order alternates by round so the verdict
// can tell "sorted on what was paid" from "kept in arrival order".
//
//   honest   maxPriorityFeePerGas = maxFeePerGas = baseFee + 2 gwei   pays 2 gwei of priority
//   overbid  maxPriorityFeePerGas = 1 gwei, maxFeePerGas = baseFee + 3 gwei   pays 1 gwei of priority
//
// The overbid violates the participant rule (maxFeePerGas <= maxPriorityFeePerGas) on purpose, so run
// this against the node, not through the RPC gateway: the gateway refuses it, and says so here.
async function probeOrderingKey(
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  walletClient: ReturnType<typeof makeClients>["walletClient"],
  chain: ReturnType<typeof makeClients>["chain"],
  keys: [Hex, Hex],
  rounds: number,
): Promise<{ verdict: string; summary: string; lines: string[] }> {
  const GWEI = 1_000_000_000n;
  const fmt = (wei: bigint) => `${Number(wei) / 1e9} gwei`;
  const lines: string[] = [];
  const pairs: KeyProbePair[] = [];
  for (let round = 0; round < rounds; round++) {
    const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 0n;
    const bids = {
      honest: {
        key: keys[round % 2],
        tip: baseFee + 2n * GWEI,
        maxFee: baseFee + 2n * GWEI,
      },
      overbid: {
        key: keys[(round + 1) % 2],
        tip: GWEI,
        maxFee: baseFee + 3n * GWEI,
      },
    };
    const order: Array<"honest" | "overbid"> =
      round % 2 === 0 ? ["honest", "overbid"] : ["overbid", "honest"];
    const hashes: Partial<Record<"honest" | "overbid", Hex>> = {};
    let refused: string | undefined;
    for (const which of order) {
      const bid = bids[which];
      const account = privateKeyToAccount(bid.key);
      try {
        hashes[which] = await walletClient.sendTransaction({
          account,
          chain,
          to: account.address,
          value: 0n,
          gas: PROBE_GAS,
          maxFeePerGas: bid.maxFee,
          maxPriorityFeePerGas: bid.tip,
        });
      } catch (error) {
        refused = `${which} refused by the RPC: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`;
      }
    }
    if (refused) {
      lines.push(`round ${round + 1}: ${refused}`);
      // Let whichever did go out land, so the next round starts from a clean pool.
      for (const hash of Object.values(hashes))
        if (hash)
          await publicClient
            .waitForTransactionReceipt({ hash, timeout: 120_000 })
            .catch(() => undefined);
      continue;
    }
    const [h, o] = await Promise.all(
      (["honest", "overbid"] as const).map((which) =>
        publicClient.waitForTransactionReceipt({
          hash: hashes[which]!,
          timeout: 120_000,
        }),
      ),
    );
    const describe = (which: "honest" | "overbid", r: typeof h): string =>
      `txIndex ${r.transactionIndex} ${which} (tip ${fmt(bids[which].tip)}, maxFee ` +
      `${fmt(bids[which].maxFee)}, paid ${fmt(r.effectiveGasPrice)}/gas)`;
    if (h.blockNumber !== o.blockNumber) {
      lines.push(
        `round ${round + 1}: split across blocks ${h.blockNumber}/${o.blockNumber}, not compared`,
      );
      continue;
    }
    const ledBy =
      o.transactionIndex < h.transactionIndex ? "overbid" : "honest";
    pairs.push({ arrivedFirst: order[0], ledBy });
    const [first, second] =
      ledBy === "overbid"
        ? ([
            ["overbid", o],
            ["honest", h],
          ] as const)
        : ([
            ["honest", h],
            ["overbid", o],
          ] as const);
    lines.push(
      `round ${round + 1} (arrived ${order.join(" then ")}), block ${h.blockNumber}: ` +
        `${describe(first[0], first[1])} before ${describe(second[0], second[1])}`,
    );
  }
  const verdict = classifyOrderingKey(pairs);
  const summary =
    verdict.verdict === "max-fee"
      ? `the builder sorts on maxFeePerGas (${pairs.length} pair(s)): an overbid paying less led every ` +
        "time. On this chain the participant rule maxFeePerGas <= maxPriorityFeePerGas is what makes " +
        "the order follow the fee paid -- keep it enforced at the RPC gateway and in postRunCheck"
      : verdict.verdict === "paid"
        ? `the builder sorts on the priority fee paid (${pairs.length} pair(s)): the honest bid led ` +
          "every time, so maxFeePerGas above the tip buys nothing here"
        : verdict.verdict === "arrival"
          ? `the builder kept arrival order in all ${pairs.length} pair(s): no fee auction at all`
          : verdict.verdict === "ambiguous"
            ? `${pairs.length} pair(s) fit ${verdict.consistent.join(" or ")}; raise --rounds to ` +
              "send the pair in both arrival orders"
            : verdict.verdict === "mixed"
              ? `no single key explains all ${pairs.length} pair(s)`
              : "INCONCLUSIVE: no pair landed in one block (or the RPC refused the overbid)";
  return { verdict: verdict.verdict, summary, lines };
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
