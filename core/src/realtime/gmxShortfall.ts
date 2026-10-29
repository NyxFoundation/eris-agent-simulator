// Feeds the GMX EventEmitter's position logs into the insolvency ledger (sdk
// protocols/gmxInsolvency.ts) as the chain goes past, for the two readers of a boundary value:
// the live scorer (liveScoring.ts, synced every block so a practice node's pruned log history is
// never needed) and the post-run sweep (reconstruct.ts, synced before each cross-section). Both
// start at the run's first block and read the same logs, so both charge the same amount at the same
// boundary -- which is what keeps `interval_series_agreement` at zero.
import type { Address, Hex, PublicClient } from "viem";
import { GMX } from "@eris/sdk/constants.js";
import {
  GMX_LEDGER_NAME_HASHES,
  GmxInsolvencyLedger,
  type GmxInsolvencyLedgerState,
  type GmxInsolventClose,
  type GmxLedgerLog,
} from "@eris/sdk/protocols/gmxInsolvency.js";

// One getLogs per this many blocks while catching up.
const LOG_CHUNK_BLOCKS = 2_000;

export type GmxShortfallTrackerState = {
  scannedThrough: number;
  ledger: GmxInsolvencyLedgerState;
};

export class GmxShortfallTracker {
  readonly ledger: GmxInsolvencyLedger;
  // Last block whose logs are in the ledger.
  private scannedThrough: number;

  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      /** First block to read logs from (the run's first competition block). */
      fromBlock: number;
      accounts: readonly Address[];
      /** Told about each insolvent close of a tracked account as it is read. */
      onInsolventClose?: (close: GmxInsolventClose) => void;
    },
  ) {
    this.ledger = new GmxInsolvencyLedger(
      new Set(opts.accounts.map((a) => a.toLowerCase())),
    );
    this.scannedThrough = opts.fromBlock - 1;
  }

  track(account: Address): void {
    this.ledger.track(account);
  }

  /** Read every EventEmitter position log through `block`. Throws when a read fails. */
  async syncTo(block: number): Promise<void> {
    while (this.scannedThrough < block) {
      const from = this.scannedThrough + 1;
      const to = Math.min(block, from + LOG_CHUNK_BLOCKS - 1);
      const logs = (await this.opts.publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            address: GMX.EventEmitter,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            // topics[1] is the event name's hash for all three EventLog shapes.
            topics: [null, GMX_LEDGER_NAME_HASHES],
          },
        ],
      } as never)) as Array<{
        topics: Hex[];
        data: Hex;
        blockNumber: Hex | null;
        logIndex: Hex | null;
        transactionHash: Hex | null;
        removed?: boolean;
      }>;
      const parsed: GmxLedgerLog[] = logs
        .filter((l) => !l.removed)
        .map((l) => ({
          topics: l.topics,
          data: l.data,
          blockNumber: l.blockNumber === null ? null : Number(l.blockNumber),
          logIndex: l.logIndex === null ? null : Number(l.logIndex),
          transactionHash: l.transactionHash,
        }));
      for (const close of this.ledger.ingest(parsed))
        this.opts.onInsolventClose?.(close);
      this.scannedThrough = to;
    }
  }

  snapshot(): GmxShortfallTrackerState {
    return { scannedThrough: this.scannedThrough, ledger: this.ledger.snapshot() };
  }

  restore(state: GmxShortfallTrackerState): void {
    this.scannedThrough = state.scannedThrough;
    this.ledger.restore(state.ledger);
  }
}
