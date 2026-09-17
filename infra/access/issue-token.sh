#!/usr/bin/env bash
# Issue one Cloudflare Access service token per participant, and print the manifest command.
#
# Why per participant and not one shared token (ASCON docs/16 §10.3, docs/18 §16):
#   - the gateway's rate limit is keyed on the token's common_name (gateway.mjs `allow(client||ip)`),
#     so ONE token means ONE 100 req/s bucket for the whole field. Measured: a single-token load test
#     tops out at exactly 100 ok/s and 429s everything above it, against ~225 req/s needed at 150
#     participants (docs/18 §17)
#   - revocation is per token. One shared secret held by 100 people leaks, and the only response is
#     cutting everyone off
#   - Loki attributes every call to `client=<common_name>`; one token makes the whole field look like
#     one caller
#
#   export CF_API_TOKEN=...            # see README.md for the two permissions it needs
#   ./issue-token.sh team-alice
#   ./issue-token.sh --list
#   ./issue-token.sh --revoke team-alice
#
# The secret is shown ONCE, by Cloudflare, at creation. This script writes it to a 0600 file and
# never echoes it; re-running for an existing participant will not get it back.
set -uo pipefail
ACCOUNT="${CF_ACCOUNT_ID:-867142363f0d467f4adcd95c13846822}"
API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/service_tokens"
OUT_DIR="${ASCON_TOKEN_DIR:-$HOME/ascon-participant-tokens}"
PREFIX="${ASCON_TOKEN_PREFIX:-ascon}"

case "${1:-}" in ""|-h|--help) sed -n '2,24p' "$0"; exit 0;; esac
: "${CF_API_TOKEN:?set CF_API_TOKEN (Account > Access: Service Tokens > Edit)}"
cf() { curl -s --max-time 30 -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" "$@"; }
die() { echo "error: $*" >&2; exit 1; }
ok()  { python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get('success') else 1)"; }

case "${1:-}" in
  --list)
    cf "$API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'): print('API error:', [e.get('message') for e in d.get('errors',[])]); sys.exit(1)
r=d.get('result') or []
print(f'{len(r)} service tokens')
for t in r: print(f\"  {t.get('name'):28} client_id={t.get('client_id','')[:12]}… created={str(t.get('created_at'))[:10]}\")"
    exit $? ;;
  --revoke)
    [ -n "${2:-}" ] || die "usage: $0 --revoke <participant-id>"
    NAME="${PREFIX}-$2"
    ID=$(cf "$API" | python3 -c "
import sys,json
for t in (json.load(sys.stdin).get('result') or []):
    if t.get('name')=='$NAME': print(t['id']); break")
    [ -n "$ID" ] || die "no token named $NAME"
    cf -X DELETE "$API/$ID" | ok && { rm -f "$OUT_DIR/$2.env"; echo "revoked $NAME"; } || die "delete failed"
    exit $? ;;
esac

PARTICIPANT="$1"
echo "$PARTICIPANT" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]{1,40}$' || die "participant id must be [A-Za-z0-9_-], 2-41 chars"
NAME="${PREFIX}-${PARTICIPANT}"

# Idempotent: refuse rather than silently issue a second token for the same participant, because the
# first one's secret is unrecoverable and two live tokens for one team defeats the revocation story.
EXISTING=$(cf "$API" | python3 -c "
import sys,json
for t in (json.load(sys.stdin).get('result') or []):
    if t.get('name')=='$NAME': print(t.get('client_id','')); break")
[ -z "$EXISTING" ] || die "$NAME already exists (client_id ${EXISTING:0:12}…). Revoke it first if you need a new secret."

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
RESP=$(cf -X POST "$API" --data "{\"name\":\"$NAME\",\"duration\":\"8760h\"}")
echo "$RESP" | ok || die "create failed: $(echo "$RESP" | python3 -c "import sys,json;print([e.get('message') for e in json.load(sys.stdin).get('errors',[])])" 2>/dev/null)"

umask 077
echo "$RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)['result']
open('$OUT_DIR/$PARTICIPANT.env','w').write(
    'CF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s\n' % (r['client_id'], r['client_secret']))
print('  name       ', r['name'])
print('  client_id  ', r['client_id'])
print('  secret     (written to the file below; shown by Cloudflare only once)')
print('  expires    ', r.get('expires_at','-'))"
chmod 600 "$OUT_DIR/$PARTICIPANT.env"

cat <<DONE

  credentials -> $OUT_DIR/$PARTICIPANT.env   (0600)

  Hand the participant that file plus their manifest:
    npm run manifest -- --participant $PARTICIPANT

  They use it as:
    set -a; . $PARTICIPANT.env; set +a
    ERIS_MANIFEST=... node --import tsx example/agents/runtime/bot.ts

  This assumes the ascon-rpc Access policy includes "any valid service token" (see README.md).
  With an explicit token list instead, add this one to the policy now or it will 403.
DONE
