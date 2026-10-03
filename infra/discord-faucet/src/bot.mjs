#!/usr/bin/env node
// ASCON practice-devnet faucet bot: registers a participant's agent and funds it, from Discord.
//
//   /faucet agent_id:<id> address:<0x…>
//
// Runs on the devnet box next to the coordinator (infra/devnet), so it writes config/registrations.yaml
// in place -- the same file and the same steps as the operator's register.sh, with no SSH and no
// inbound port: Discord is reached over an outbound gateway connection. See README.md.
//
// Who may ask: members holding the participant role. The role itself is kept in step with the
// registration spreadsheet (its "Discord username" column) every few minutes and when someone joins,
// because rules §2.7 opens the Trial Environment to registered participants only.
//
// How many: one agent per Discord account (claims.json). A second agent is the operator's call.
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkRequest, nextSegmentStart, registrationEntry, sheetUsernames, tokyoDate } from "./lib.mjs";
import { createSheetReader } from "./sheets.mjs";
import {
  appendRegistration,
  balancesLine,
  currentSegmentDir,
  eventsOffset,
  readRegistrations,
  waitForVerdict,
} from "./devnet.mjs";

// ---- configuration (EnvironmentFile of the unit; see README.md) ----
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
const cfg = {
  token: required("DISCORD_TOKEN"),
  guildId: required("DISCORD_GUILD_ID"),
  roleId: required("PARTICIPANT_ROLE_ID"),
  opsChannelId: process.env.OPS_CHANNEL_ID || null,
  sheet: {
    keyFile: required("GOOGLE_SA_KEY_FILE"),
    spreadsheetId: required("SHEET_ID"),
    range: required("SHEET_RANGE"),
    usernameHeader: process.env.SHEET_USERNAME_HEADER || "Discord ユーザー名 / Discord username",
    approvedHeader: process.env.SHEET_APPROVED_HEADER || undefined,
    approvedValue: process.env.SHEET_APPROVED_VALUE || "TRUE",
  },
  repoDir: process.env.REPO_DIR || join(homedir(), "workspace/eris-agent-simulator"),
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
  stateDir: process.env.STATE_DIR || join(homedir(), ".local/state/ascon-faucet"),
  syncMinutes: Number(process.env.SYNC_MINUTES || 10),
  maxPerHour: Number(process.env.MAX_PER_HOUR || 20),
  segmentHours: Number(process.env.SEGMENT_HOURS || 24),
  dashboardUrl: process.env.DASHBOARD_URL || "https://ascon-dash.nyx.foundation",
  // Checks everything, writes nothing, adds no role: for the first start on the box.
  dryRun: process.env.DRY_RUN === "1",
};

// ---- claims: which Discord account registered which agent (one each) ----
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
const claimsFile = join(cfg.stateDir, "claims.json");
function loadClaims() {
  try {
    return JSON.parse(readFileSync(claimsFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
function saveClaims(claims) {
  const tmp = `${claimsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(claims, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, claimsFile);
}

// ---- the spreadsheet ----
const readSheet = createSheetReader(cfg.sheet);
async function admittedUsernames() {
  return sheetUsernames(await readSheet(), cfg.sheet);
}

// ---- Discord ----
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

async function ops(text) {
  console.log(`[ops] ${text}`);
  if (!cfg.opsChannelId) return;
  try {
    const channel = await client.channels.fetch(cfg.opsChannelId);
    await channel?.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`[ops] could not post: ${error.message}`);
  }
}

async function grantRole(member, why) {
  if (member.roles.cache.has(cfg.roleId)) return false;
  if (cfg.dryRun) {
    console.log(`[roles] dry run: would add the role to ${member.user.username} (${why})`);
    return true;
  }
  await member.roles.add(cfg.roleId, why);
  return true;
}

/** Give the role to every member the sheet admits. Adds only: removing a role stays a person's call. */
async function syncRoles() {
  const { admitted, unreadable } = await admittedUsernames();
  const guild = await client.guilds.fetch(cfg.guildId);
  const members = await guild.members.fetch();
  const present = new Set();
  const added = [];
  for (const member of members.values()) {
    if (member.user.bot) continue;
    const name = member.user.username.toLowerCase();
    if (!admitted.has(name)) continue;
    present.add(name);
    if (await grantRole(member, "listed in the registration sheet")) added.push(name);
  }
  const missing = [...admitted].filter((n) => !present.has(n));
  console.log(
    `[roles] sheet ${admitted.size}, on the server ${present.size}, added ${added.length}, ` +
      `not on the server ${missing.length}, unreadable ${unreadable.length}`,
  );
  if (added.length > 0)
    await ops(`参加者ロールを付与しました${cfg.dryRun ? "（dry run）" : ""}: ${added.join(", ")}`);
  return { missing, unreadable };
}

const command = new SlashCommandBuilder()
  .setName("faucet")
  .setDescription("Register your agent on the practice devnet and receive the starting funds")
  .setDescriptionLocalizations({ ja: "練習環境にエージェントを登録し、初期資金を受け取ります" })
  .addStringOption((o) =>
    o
      .setName("agent_id")
      .setDescription("Your agent's id (letters, digits, . _ -; up to 64)")
      .setDescriptionLocalizations({ ja: "エージェントの id（英数字と . _ -、64 文字まで）" })
      .setRequired(true)
      .setMaxLength(64),
  )
  .addStringOption((o) =>
    o
      .setName("address")
      .setDescription("The address your agent signs with (0x…, 42 characters). Use a key only you hold")
      .setDescriptionLocalizations({ ja: "エージェントが署名に使うアドレス（0x…、42 文字）。自分だけが持つ鍵のもの" })
      .setRequired(true)
      .setMinLength(42)
      .setMaxLength(42),
  );

const REFUSALS = {
  "bad-agent-id": "id は英数字と `.` `_` `-` で、先頭は英数字、64 文字までです。\nThe id must be letters, digits, `.`, `_` or `-`, start with a letter or digit, and be at most 64 characters.",
  "bad-address": "アドレスの形式が正しくありません（`0x` + 16 進 40 文字）。\nThat is not a valid address (`0x` followed by 40 hex characters).",
  "agent-id-taken": "その id は既に使われています。別の id にしてください。\nThat id is already taken; please choose another.",
  "address-taken": "そのアドレスは既に登録されています。\nThat address is already registered.",
};

// One registration at a time: two concurrent appends would race on the file and on claims.json.
let queue = Promise.resolve();
const recent = [];

async function handleFaucet(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const agentId = interaction.options.getString("agent_id", true).trim();
  const address = interaction.options.getString("address", true).trim();
  const member = interaction.member;
  const user = interaction.user;

  // Participant role, or -- for someone registered since the last sync -- a fresh look at the sheet.
  if (!member.roles.cache.has(cfg.roleId)) {
    const { admitted } = await admittedUsernames();
    if (!admitted.has(user.username.toLowerCase())) {
      await interaction.editReply(
        "参加登録フォームの Discord ユーザー名とあなたのユーザー名が一致しないため、受け付けられません。" +
          "登録済みの場合は、フォームに書いたユーザー名を運営にお知らせください。\n" +
          "Your Discord username does not match a registration in the form. If you have registered, " +
          "tell the organizers the username you entered.",
      );
      return;
    }
    await grantRole(member, "listed in the registration sheet (on /faucet)");
  }

  const run = async () => {
    const claims = loadClaims();
    const registered = readRegistrations(cfg.repoDir);
    const verdict = checkRequest({ userId: user.id, agentId, address, registered, claims });
    if (!verdict.ok) {
      if (verdict.reason === "already-claimed") {
        const e = verdict.existing;
        await interaction.editReply(
          `このアカウントでは既に登録済みです（\`${e.agentId}\` / \`${e.address}\`）。2 体目は運営にご相談ください。\n` +
            `This account has already registered \`${e.agentId}\`. Ask the organizers about a second agent.`,
        );
      } else await interaction.editReply(REFUSALS[verdict.reason]);
      return;
    }

    const hourAgo = Date.now() - 3_600_000;
    while (recent.length && recent[0] < hourAgo) recent.shift();
    if (recent.length >= cfg.maxPerHour) {
      await interaction.editReply(
        "申請が集中しているため、少し時間をおいて再度お試しください。\nToo many requests right now; please try again later.",
      );
      await ops(`1 時間あたりの上限（${cfg.maxPerHour} 件）に達したため、${user.username} の申請を保留しました`);
      return;
    }

    if (cfg.dryRun) {
      await interaction.editReply(`dry run: \`${agentId}\` / \`${address}\` は受け付け可能です（書き込みはしていません）。`);
      return;
    }

    const { period, segmentDir } = currentSegmentDir(cfg.repoDir);
    const offset = eventsOffset(segmentDir);
    const { entries } = appendRegistration(
      cfg.repoDir,
      agentId,
      registrationEntry({ agentId, address, date: tokyoDate() }),
    );
    claims[user.id] = { agentId, address, username: user.username, at: new Date().toISOString() };
    saveClaims(claims);
    recent.push(Date.now());
    await interaction.editReply(
      `\`${agentId}\` を登録しました。入金を確認しています（1〜2 分）…\nRegistered \`${agentId}\`. Confirming the funds (1–2 minutes)…`,
    );

    const result = await waitForVerdict(segmentDir, offset, agentId);
    if (result.kind !== "registered") {
      await interaction.editReply(
        "登録の反映を確認できませんでした。運営が確認してご連絡します。\n" +
          "The registration could not be confirmed; the organizers will check and get back to you.",
      );
      await ops(
        `⚠️ ${user.username} の \`${agentId}\` / \`${address}\`: ${result.kind}${result.detail ? ` — ${result.detail}` : ""}` +
          `（登録ファイル ${entries} 件。控えは ~/registrations.yaml.before-${agentId}）`,
      );
      return;
    }
    const balances = await balancesLine(cfg.repoDir, cfg.rpcUrl, address);
    const next = nextSegmentStart(period, cfg.segmentHours);
    const nextJst = next
      ? new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(next) + " JST"
      : null;
    await interaction.editReply(
      `✅ \`${agentId}\` を登録し、入金しました: ${balances}\n` +
        (nextJst ? `練習順位の採点は、次の日の区切り（${nextJst}）から始まります。\n` : "") +
        `ダッシュボード: ${cfg.dashboardUrl}\n\n` +
        `✅ Registered \`${agentId}\` and funded it: ${balances}\n` +
        (nextJst ? `Practice scoring starts at the next day boundary (${nextJst}).\n` : "") +
        `Dashboard: ${cfg.dashboardUrl}`,
    );
    await ops(`登録: ${user.username} → \`${agentId}\` / \`${address}\`（${balances}。登録ファイル ${entries} 件）`);
  };

  queue = queue.then(run, run).catch(async (error) => {
    console.error(error);
    await interaction
      .editReply("エラーが発生しました。運営が確認します。\nSomething went wrong; the organizers will look into it.")
      .catch(() => {});
    await ops(`❌ ${user.username} の \`${agentId}\` の処理でエラー: ${error.message}`);
  });
  await queue;
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}${cfg.dryRun ? " (dry run)" : ""}`);
  await new REST()
    .setToken(cfg.token)
    .put(Routes.applicationGuildCommands(c.user.id, cfg.guildId), { body: [command.toJSON()] });
  const tick = () =>
    syncRoles().catch((error) => ops(`❌ ロールの同期に失敗しました: ${error.message}`));
  await tick();
  setInterval(tick, cfg.syncMinutes * 60_000);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== cfg.guildId || member.user.bot) return;
  try {
    const { admitted } = await admittedUsernames();
    if (admitted.has(member.user.username.toLowerCase()))
      if (await grantRole(member, "listed in the registration sheet (on join)"))
        await ops(`参加者ロールを付与しました（参加時）: ${member.user.username}`);
  } catch (error) {
    console.error(`[roles] on join: ${error.message}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "faucet") return;
  if (interaction.guildId !== cfg.guildId) return;
  try {
    await handleFaucet(interaction);
  } catch (error) {
    console.error(error);
    await interaction.editReply("エラーが発生しました。運営が確認します。\nSomething went wrong.").catch(() => {});
    await ops(`❌ /faucet の処理でエラー: ${error.message}`);
  }
});

await client.login(cfg.token);
