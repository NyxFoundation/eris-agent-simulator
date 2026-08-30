// `npm run manifest` -- the handout for a self-hosted participant (ADR 0021 §2).
//
//   npm run manifest                      write manifest.json (public: no keys, no stress timings)
//   npm run manifest -- --print           print it instead of writing
//   npm run manifest -- --participant <id>  that participant's credentials, to stdout only
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

export function runManifestCli(): void {
  const flags = parseCliFlags(process.argv);
  const { config, agents } = resolveRunInputs(process.argv);
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
