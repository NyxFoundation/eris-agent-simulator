// `npm run manifest` -- the handout for a self-hosted participant (ADR 0021 §2).
//
//   npm run manifest                      write manifest.json (public: no keys, no stress timings)
//   npm run manifest -- --print           print it instead of writing
//   npm run manifest -- --participant <id>  that participant's credentials, to stdout only
//   npm run manifest -- --public-rpc <url>  the URL participants dial, not the one we dial
//   npm run manifest -- --from-run <dir>    the running period's own manifest (below)
//
// `--public-rpc` exists because one field was doing two jobs. `chain.rpcUrl` comes from
// ANVIL_RPC_URL, which on the box that hosts the competition is `http://127.0.0.1:8545` -- correct
// for the coordinator, and the single worst thing to hand a participant: it names *their* loopback,
// and :8545 is the raw anvil rather than the gateway that refuses cheatcodes. A manifest is by
// definition read on someone else's machine, so it says the public URL or it says something wrong.
// The flag overrides `run.publicRpcUrl` / ERIS_PUBLIC_RPC_URL, which is what the coordinator uses
// for the manifest it writes into the run directory (issue #156).
//
// This file is not what a participant starts an agent from. The PriceFeed is deployed when the
// coordinator starts, so a handout produced before that has no `contracts.priceFeed`, and every
// restart (a new competition) deploys a new one; the runtime exits without it. The manifest a
// running period serves -- `<dashboard>/runs/manifest.json` -- has it, and names the public URL once
// ERIS_PUBLIC_RPC_URL is set on the box. This command is for reading what a config will publish.
//
// The split is the whole design. The public manifest is copied into READMEs and served by the
// dashboard out of the run directory, so anything in it is published; a participant's key is handed
// over one at a time and never written to a file the operator might later serve.
//
// `--from-run` exists because a manifest built from the config alone cannot run an agent. The
// PriceFeed is deployed when the period starts, and the period's clock -- the block its length counts
// from, the instant its days are cut from -- starts with it; only the coordinator knows them, and it
// writes them into the run directory's manifest.json. So the handout for a running period is that
// file, with the public RPC put in place of the coordinator's own. Given the competition directory it
// follows `current-segment` to the segment that is current.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountAddress } from "@eris/sdk/chain.js";
import { safeStringify } from "@eris/sdk/logger.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import { privateKeyForWalletName } from "./config.js";
import {
  buildManifest,
  isLoopbackUrl,
  type EnvironmentManifest,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA,
  publishedRpc,
  type ManifestParticipant,
} from "./manifest.js";
import { parseCliFlags, resolveRunInputs } from "./runConfig.js";
import { CURRENT_SEGMENT_FILE } from "./segments.js";

/**
 * The coordinator's manifest for the run at `dir`: a run (or segment) directory, or a competition
 * directory, whose `current-segment` names the segment being written now.
 */
export function readRunManifest(dir: string): {
  manifest: EnvironmentManifest;
  path: string;
} {
  const pointer = join(dir, CURRENT_SEGMENT_FILE);
  const runDir = existsSync(pointer)
    ? readFileSync(pointer, "utf8").trim()
    : dir;
  const path = join(runDir, MANIFEST_FILENAME);
  if (!existsSync(path))
    throw new Error(
      `${path} does not exist. --from-run takes the directory the coordinator is writing (a run, a ` +
        "segment, or the period's competition directory under runs/)",
    );
  const manifest = JSON.parse(readFileSync(path, "utf8")) as EnvironmentManifest;
  if (manifest.schema !== MANIFEST_SCHEMA)
    throw new Error(
      `${path} is not an environment manifest (schema ${JSON.stringify(manifest.schema)})`,
    );
  return { manifest, path };
}

/** The handout: the coordinator's manifest, dialled at the URL participants can reach. */
export function handoutFromRun(
  manifest: EnvironmentManifest,
  publicRpc: string | undefined,
): EnvironmentManifest {
  if (!publicRpc) return manifest;
  return {
    ...manifest,
    chain: { ...manifest.chain, rpcUrl: publicRpc, readRpcUrl: publicRpc },
  };
}

export function runManifestCli(): void {
  const flags = parseCliFlags(process.argv);
  const { config: rawConfig, agents } = resolveRunInputs(process.argv);
  const publicRpc = flags["public-rpc"];
  const config =
    publicRpc && publicRpc !== "1"
      ? { ...rawConfig, publicRpcUrl: publicRpc }
      : rawConfig;
  const { rpcUrl } = publishedRpc(config);
  // The token and venue registries are protocol-driven, and the manifest publishes both.
  initProtocols(config.enabledProtocols);

  const participants: ManifestParticipant[] = agents.map((spec) => ({
    id: spec.id,
    address:
      spec.address ??
      accountAddress(privateKeyForWalletName(config, spec.wallet, spec.id)),
    external: spec.external === true,
    baseline: spec.baseline ?? false,
    description: spec.description,
    ...(spec.participant !== undefined
      ? { participant: spec.participant }
      : {}),
  }));

  if (flags.participant) {
    const spec = agents.find((a) => a.id === flags.participant);
    if (!spec) {
      console.error(
        `no agent "${flags.participant}" in the roster (have: ${agents.map((a) => a.id).join(", ")})`,
      );
      process.exit(1);
    }
    const address =
      spec.address ??
      accountAddress(privateKeyForWalletName(config, spec.wallet, spec.id));
    console.log(`agent id : ${spec.id}`);
    console.log(`address  : ${address}`);
    console.log(`rpc      : ${rpcUrl}`);
    console.log(`chainId  : ${config.chainId}`);
    if (spec.address) {
      // Registered by address: there is no key here, and that is the safer arrangement -- a key the
      // operator generated is a key the operator has.
      console.log("key      : (held by the participant; nothing to hand over)");
    } else {
      console.log(
        `key      : ${privateKeyForWalletName(config, spec.wallet, spec.id)}`,
      );
      console.error(
        "\n[manifest] the line above is a private key. It is printed rather than written to a " +
          "file because the run directory this would land in is served over HTTP by the dashboard.",
      );
    }
    return;
  }

  const fromRun = flags["from-run"];
  let manifest: EnvironmentManifest;
  if (fromRun && fromRun !== "1") {
    const read = readRunManifest(fromRun);
    manifest = handoutFromRun(
      read.manifest,
      publicRpc && publicRpc !== "1" ? publicRpc : undefined,
    );
    console.error(`[manifest] from ${read.path}`);
    if (manifest.period?.startBlock === undefined)
      console.error(
        "[manifest] WARNING: that run has not declared its first block yet, so the handout has no " +
          "period start: blocksRemaining falls back to the end date and dayBlocksRemaining is left " +
          "out. Rebuild it once the run's first block has been mined.",
      );
  } else {
    manifest = buildManifest({ config, participants });
    // Not a failure: a manifest built before the period starts is still the document to read. But
    // it is not one an agent can start from, and the handout step should not find that out from a
    // participant.
    console.error(
      "[manifest] NOTE: built from the config alone -- no PriceFeed address and no period start " +
        "(both exist only once the coordinator has started, and change at every restart). A " +
        "self-hosted agent cannot start from this file. Hand participants the manifest the running " +
        "period serves, <dashboard>/runs/manifest.json (docs/guide/practice-devnet.md §2), or build " +
        "it by hand with --from-run runs/<period>.",
    );
  }
  // Say it out loud rather than shipping a handout that names the reader's own loopback. Not a
  // hard failure: a participant running the whole thing locally has a legitimately local rpcUrl.
  // Checked on the file being written, which under --from-run is the coordinator's own URL unless
  // --public-rpc replaced it (or the coordinator had ERIS_PUBLIC_RPC_URL, issue #156).
  if (isLoopbackUrl(manifest.chain.rpcUrl))
    console.error(
      `[manifest] WARNING: chain.rpcUrl is ${manifest.chain.rpcUrl} — a loopback address.\n` +
        "[manifest] That is correct for a local run and wrong for anything handed to a participant:\n" +
        "[manifest] it names their machine, not this one. Pass --public-rpc <url> (the gateway, e.g.\n" +
        "[manifest] https://ascon-rpc.nyx.foundation/) when producing the handout.",
    );
  // safeStringify, not JSON.stringify: the venue constants carry bigints (seed depths, caps).
  const text = `${safeStringify(manifest, 2)}\n`;
  if (flags.print) {
    console.log(text);
    return;
  }
  const out = flags.out ?? MANIFEST_FILENAME;
  writeFileSync(out, text);
  console.error(
    `[manifest] wrote ${out} — ${manifest.protocols.length} venue(s), ` +
      `${manifest.participants.length} participant(s), no keys, no episode timings`,
  );
}
