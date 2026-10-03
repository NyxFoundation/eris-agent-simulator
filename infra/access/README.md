# infra/access — one credential per participant

> **2026-09-21: the credential is no longer a Cloudflare service token.** They cap at **50 per
> account**, which a 100+ participant field cannot fit. Measured, not read from the docs: with 50
> in existence the 51st create fails `org_has_exceeded_allowed_token_count`, and revoking one frees
> a slot immediately — so it caps tokens *existing*, not a rate. The docs offer only "may be
> increased on Enterprise accounts", which is a sales call rather than a price.
>
> Participants now carry **two** headers:
>
> | | issued by | purpose |
> |---|---|---|
> | `X-ASCON-Key` | `issue-key.sh` (this repo) | **who** — the rate-limit bucket, the log line, the thing you revoke |
> | `CF-Access-Client-Id` / `-Secret` | one **shared** Cloudflare service token | the edge gate, so unauthenticated junk dies at Cloudflare rather than at our box |
>
> The three properties the per-participant design existed for are unchanged, and were re-verified
> in production on 2026-09-21: per-key rate limiting (team-001 burst to empty, team-002 then got a
> full bucket of its own), per-key revocation (a file edit, picked up within 15 s), per-key
> attribution (`client=team-001` in the gateway log). The gateway stores sha256 digests only, so
> what is deployed to the box cannot be turned back into a key.
>
> `issue-token.sh` below still issues Cloudflare service tokens, and is still how the **shared**
> edge token and the operator's own are made. It is no longer how participants are identified.

## Issuing participant keys

```sh
infra/access/issue-key.sh --generate 120     # -> rpc-keys.json (digests) + .secrets.csv (handout)
infra/access/issue-key.sh --revoke team-007  # gateway re-reads within 15 s; no restart
infra/access/issue-key.sh --list
```

Point the gateway at the digest map (`ASCON_KEYS_FILE` in `infra/monitoring/.env`). Setting it
makes `X-ASCON-Key` mandatory — there is no separate enable flag, because a flag is a thing to
forget and the cost of forgetting it is an open chain.

### A key sends only from its bound addresses

The gateway used to check the key and never who signed: any participant could submit a transaction
signed by any private key they knew (one derived from a public seed, issue #189, or one of anvil's
public test accounts) and trade as that address. `eth_sendRawTransaction` now recovers the signer and
refuses, 403 `-32003`, one that is not bound to the caller's key:

```sh
infra/access/issue-key.sh --bind team-007 0x…      # the address they registered
infra/access/issue-key.sh --unbind team-007 [0x…]  # drop one, or all of them
infra/access/issue-key.sh --list                   # shows "sends from:" per key
```

Normally nothing is bound by hand. The coordinator writes the registered field to
`run.sendersFile` (`runs/rpc-senders/senders.json` in `config/practice.yaml`) whenever it changes,
the gateway reads it (`RPC_SENDERS_FILE`), and matches a registration's `participant` (or its `id`
without one) to the key's id. So the only rule is: **issue the key under the registration's
participant name** (`issue-key.sh --issue team-alice`). `--bind` is the fallback for an address the
registrations do not hold. A key with **no** binding reads but cannot send. An address can be bound
by hand to one key only. `RPC_SENDER_CHECK=0` disables the check (internal gateways only).

**Before deploying this gateway version on a running period:** keys issued earlier are named
`team-NNN` while registrations use their own `participant`. For those, either `--bind team-NNN 0x…`
each registered address, or re-issue under the participant name (`--revoke` + `--issue`). Until
then their submissions are refused. Also create `runs/rpc-senders/` on the box as the coordinator's
user before `docker compose up` (otherwise docker creates it root-owned and the write fails).

### The four checks that mean it is working

```
valid key            -> 200
no key / wrong key   -> 403 {"code":-32001,"message":"missing or unknown X-ASCON-Key"}
anvil_setBalance     -> 403 "method not permitted"
no CF headers        -> 403 at the Cloudflare edge
```

All four verified through `https://ascon-rpc.nyx.foundation/` on 2026-09-21, and the gateway log
after the cutover contains zero successful unauthenticated calls.

---

## (historical) one service token per participant

`ascon-rpc.nyx.foundation` is behind Cloudflare Access, and agents authenticate with a **service
token** (a program cannot complete an email redirect — ASCON docs/16 §10.3). This directory issues
one per participant.

## Why not a single shared token

It is tempting, and it breaks in three ways. The first is measured, not theoretical:

| | one shared token | one per participant |
|---|---|---|
| **rate limit** | the gateway keys its bucket on the token's `common_name` (`gateway.mjs`: `allow(client \|\| ip, cost)`), so **the whole field shares one 100 req/s bucket**. A single-token load test topped out at exactly 100 ok/s and 429'd everything above — against ~225 req/s needed at 150 participants (docs/18 §17) | 100 req/s each ≈ 67× the 1.5 req/s a participant needs |
| **revocation** | a secret held by 100 people leaks, and the only response is cutting everyone off | delete that one token |
| **attribution** | Loki logs `client=<common_name>`; the whole field looks like one caller | per-team "who called what when" (docs/18 §16) |

## The API token this needs

Create at **My Profile → API Tokens → Create Token → Custom**:

| | |
|---|---|
| Permission | **Account → Access: Service Tokens → Edit** |
| Account | the one holding `nyx.foundation` (`867142363f0d467f4adcd95c13846822`) |

`~/.cloudflared/cert.pem` does **not** work here — it is an `ARGO TUNNEL TOKEN`, scoped to tunnel
operations only.

```sh
export CF_API_TOKEN=...          # keep it out of the repo; ~/.hermes/.env on the ops box
```

## Use

```sh
./issue-token.sh team-alice      # issue; writes ~/ascon-participant-tokens/team-alice.env (0600)
./issue-token.sh --list          # what exists
./issue-token.sh --revoke team-alice
```

Issuing is idempotent by refusal: a second run for the same participant stops rather than creating a
second live token, because **Cloudflare shows the secret once** and two tokens for one team defeats
the revocation story. To rotate, revoke then issue.

## The Access policy

Two shapes work, and they differ in how much work issuing is:

1. **`any valid service token`** (recommended) — the policy accepts any service token on the account,
   so issuing is just this script; no policy edit per participant. You still keep all three benefits
   above, because they come from the token's identity, not from the policy.
2. **an explicit token list** — tighter, but every issuance also needs the new token added to the
   policy, by hand or by a second API call.

Whichever is in use, the policy's **Action must be `Service Auth`**. A plain `Allow` policy rejects
service tokens, which is the most common way this ends in a 403 that looks like a bad secret.

## Handing it over

```sh
npm run manifest -- --participant team-alice
```

The manifest carries the RPC URL, chain id and venue addresses; the `.env` carries the credentials.
Same granularity, so issue them together.

## Onboarding one participant, start to finish

Three commands, in this order. None of them restarts the coordinator — a restart opens a new
competition directory and the standings start from zero (`infra/devnet/README.md`), which is the
one thing that must not happen once a period is running.

```sh
# 1. register the address they sent you. Re-read every ~30 blocks (about a minute).
$EDITOR config/registrations.yaml        # on the box: ~/workspace/eris-agent-simulator
#   - id: alice
#     address: "0x…"          # their key, their custody — the operator holds none (規約 第8条の2)
#     participant: team-alice

# 2. issue their service token
infra/access/issue-token.sh alice        # -> ~/ascon-participant-tokens/alice.env (0600)

# 2b. issue their X-ASCON-Key under the `participant` from step 1 (or the `id` without one). The
#     coordinator publishes the registered address to the gateway (run.sendersFile), which lets
#     this key send from it ~1 min later; with a different name every send is 403 (see above)
infra/access/issue-key.sh --issue team-alice    # the key is the last line of .secrets.csv

# 3. build the handout manifest — --public-rpc or it names *their* loopback, --from-run or it has
#    no PriceFeed and no period start (the running period's own manifest; see docs/guide/practice-devnet.md)
npm run manifest -- --config config/practice.yaml \
  --public-rpc https://ascon-rpc.nyx.foundation/ --from-run runs/<period> \
  --out ~/ascon-handout/manifest.json
```

Hand over `alice.env` + `manifest.json`. They use them as:

```sh
set -a; . alice.env; set +a                 # CF_ACCESS_CLIENT_ID / _SECRET
ERIS_MANIFEST=manifest.json ERIS_CONFIG=config/practice.yaml node --import tsx example/agents/runtime/bot.ts
```

### Confirm it took, rather than assuming

```sh
# the registration landed (the event is only written when something changes)
journalctl --user -u ascon-devnet --since "5 min ago" | grep registrations
#   [registrations] registered alice (0x…) at block 866

# the token reaches the chain and cheatcodes still do not
curl -s -X POST -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://ascon-rpc.nyx.foundation/          # -> {"result":"0x…"}
#   anvil_setBalance on the same URL must answer 403 "method not permitted"
```

Measured 2026-09-21 on the running practice devnet: `eth_blockNumber` / `eth_chainId` /
`eth_getBalance` returned 200, and `anvil_setBalance` / `evm_mine` / `anvil_impersonateAccount`
each returned 403 `method not permitted`.

### Revoking

`issue-token.sh --revoke alice` deletes the token; the next call from it is a 403 at the edge. The
registration stays — the address is still funded and still in the standings. Remove the entry from
`config/registrations.yaml` as well if the intent is that they leave the period.
