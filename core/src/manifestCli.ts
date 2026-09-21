// `npm run manifest` -- the handout for a self-hosted participant (ADR 0021 §2).
//
//   npm run manifest                      write manifest.json (public: no keys, no stress timings)
//   npm run manifest -- --print           print it instead of writing
//   npm run manifest -- --participant <id>  that participant's credentials, to stdout only
//   npm run manifest -- --public-rpc <url>  the URL participants dial, not the one we dial
//
// `--public-rpc` exists because one field was doing two jobs. `chain.rpcUrl` comes from
// ANVIL_RPC_URL, which on the box that hosts the competition is `http://127.0.0.1:8545` -- correct
// for the coordinator, and the single worst thing to hand a participant: it names *their* loopback,
// and :8545 is the raw anvil rather than the gateway that refuses cheatcodes. A manifest is by
// definition read on someone else's machine, so it says the public URL or it says something wrong.
//
// The split is the whole design. The public manifest is copied into READMEs and served by the
// dashboard out of the run directory, so anything in it is published; a participant's key is handed
// over one at a time and never written to a file the operator might later serve.
import { writeFileSync } from "node:fs";
import { accountAddress } from "@eris/sdk/chain.js";
import { safeStringify } from "@eris/sdk/logger.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import { privateKeyForWalletName } from "./config.js";
import {
  buildManifest,
  MANIFEST_FILENAME,
  type ManifestParticipant,
} from "./manifest.js";
import { parseCliFlags, resolveRunInputs } from "./runConfig.js";

/** A URL only reachable from the machine that is serving it. */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function runManifestCli(): void {
  const flags = parseCliFlags(process.argv);
  const { config: rawConfig, agents } = resolveRunInputs(process.argv);
  const publicRpc = flags["public-rpc"];
  const config =
    publicRpc && publicRpc !== "1"
      ? { ...rawConfig, rpcUrl: publicRpc, readRpcUrl: publicRpc }
      : rawConfig;
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
    console.log(`rpc      : ${config.rpcUrl}`);
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

  // Say it out loud rather than shipping a handout that names the reader's own loopback. Not a
  // hard failure: a participant running the whole thing locally has a legitimately local rpcUrl.
  if (isLoopback(config.rpcUrl))
    console.error(
      `[manifest] WARNING: chain.rpcUrl is ${config.rpcUrl} — a loopback address.\n` +
        "[manifest] That is correct for a local run and wrong for anything handed to a participant:\n" +
        "[manifest] it names their machine, not this one. Pass --public-rpc <url> (the gateway, e.g.\n" +
        "[manifest] https://ascon-rpc.nyx.foundation/) when producing the handout.",
    );
  const manifest = buildManifest({ config, participants });
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
      `${participants.length} participant(s), no keys, no episode timings`,
  );
}
