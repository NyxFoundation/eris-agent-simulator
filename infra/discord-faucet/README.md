# Faucet bot (Discord)

Registers a participant's agent on the practice devnet and funds it, from Discord:

```
/faucet agent_id:<id> address:<0x…>
```

It runs **on the devnet box**, next to the coordinator (`infra/devnet`), and does in place what the
operator's `register.sh` does over SSH:

1. checks the request — the requester holds the participant role, has not registered an agent
   before (one per Discord account), and the id and address are well-formed and not taken
2. backs up `config/registrations.yaml` to `~/registrations.yaml.before-<id>` and appends the entry.
   The coordinator re-reads the file about once a minute and registers and funds the address
   without a restart (ETH 1 / WETH 8 / WBTC 0.4 / USDC 25,000)
3. watches the current segment's `events.jsonl` for the coordinator's verdict on that id
4. reads the address's balances from the chain and replies to the requester (only they see it)

No port is opened: Discord is reached over an outbound gateway connection.

**Who may use it.** Rules §2.7 opens the Trial Environment to registered participants. The bot
keeps the participant role in step with the registration spreadsheet. Every `SYNC_MINUTES`, and
when someone joins the server, it gives the role to members whose username appears in the sheet's
"Discord username" column. It only adds the role; taking it away is left to a person. A member
without the role who registered after the last sync gets a fresh look at the sheet when they run
`/faucet`.

**What it does not check**, the same as `register.sh`: that the requester holds the key of the
address. A mistyped address is registered and funded, and nobody can move that agent. The reply
repeats the address for that reason.

## Setup

### Discord

1. Developer Portal → New Application → Bot: copy the token. Under *Privileged Gateway Intents*,
   turn on **Server Members Intent** (the role sync lists the members).
2. Invite it with the scopes `bot` and `applications.commands` and the permission **Manage Roles**.
3. Create the participant role if there is none, and drag the bot's own role **above** it (Discord
   only lets a bot assign roles below its own).
4. With Developer Mode on, copy the server id, the role id and, optionally, the id of a private
   channel for operator notices (`OPS_CHANNEL_ID`). Every registration, every role grant and every
   failure is posted there.

### Google

1. In a Google Cloud project, enable the **Google Sheets API** and create a service account. Create
   a JSON key for it.
2. Share the registration spreadsheet with the service account's address as a **viewer**.
3. Note the spreadsheet id (from its URL), the sheet name of the responses (`SHEET_RANGE`, e.g.
   `フォームの回答 1!A:Z`) and the header of the Discord username column.

### The box

```sh
cd ~/workspace/eris-agent-simulator/infra/discord-faucet
npm ci --omit=dev
cp faucet.env.example ~/.config/ascon-faucet.env && chmod 600 ~/.config/ascon-faucet.env   # fill it in
# the service-account key, readable by this user only:
chmod 600 ~/.config/ascon-faucet-sa.json
ln -sf "$PWD/ascon-faucet.service" ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ascon-faucet
journalctl --user -u ascon-faucet -f
```

Start with `DRY_RUN=1` (the template's value). The bot logs in, registers `/faucet`, and reports
the role sync without adding any role, e.g. `[roles] sheet 42, on the server 39, added 39, …`. A
`/faucet` then answers whether the request would be accepted, and writes nothing. When the numbers
look right, set `DRY_RUN=0` and `systemctl --user restart ascon-faucet`.

## Operating it

- **One per account** is `~/.local/state/ascon-faucet/claims.json` (`{ "<discord user id>":
  { agentId, address, username, at } }`). Participants registered by hand before the bot know
  nothing of it, so they could claim a second agent. To prevent that, add them here, keyed by
  their Discord user id.
- **A second agent** for someone is the operator's decision: register it with `register.sh`, with
  `--participant` if the two belong to the same unit (rules §2.2).
- **Rate limit**: at most `MAX_PER_HOUR` registrations an hour across everyone, so a role handed
  out by mistake (a sheet edit gone wrong) can produce that many registrations before someone
  notices in the ops channel, not an unbounded number.
- **What is public**: the registration entry's `description` reaches the manifest, so it names the
  bot and the date, not the Discord account. The account ↔ agent mapping stays in `claims.json` on
  the box.
- **If the reply says the registration could not be confirmed**: the ops channel has the
  coordinator's verdict (`ignored`, `failed`, `reload-failed` or `timeout`) and the backup's path.
  `reload-failed` means the file no longer parses and **no later registration is picked up either**.
  Compare it with the backup.

## Tests

```sh
npm test    # the request checks, the sheet parsing, the YAML entry, the segment clock
```
