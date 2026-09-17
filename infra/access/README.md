# infra/access — one service token per participant

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
