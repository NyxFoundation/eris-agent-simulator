#!/usr/bin/env bash
# Issue the per-participant RPC keys this gateway authenticates on.
#
#   ./issue-key.sh --generate 120 [--out <keys.json>]   mint N keys + the gateway's lookup file
#   ./issue-key.sh --add 380                            mint N more, keeping every existing key
#   ./issue-key.sh --issue team-alice                   mint one under a chosen id (the registration's
#                                                       `participant`, or its `id` without one)
#   ./issue-key.sh --revoke team-007                    drop one (the gateway re-reads within 15 s)
#   ./issue-key.sh --bind team-007 0xAbC…               let that key send from that address, by hand
#   ./issue-key.sh --unbind team-007 [0xAbC…]           drop a hand binding (or all of the key's)
#   ./issue-key.sh --list
#
# A key can READ with no binding, but eth_sendRawTransaction is refused (403) unless the signer is
# an address bound to the key -- otherwise any participant could send as any address whose private
# key they happened to know. Normally nothing needs binding: the coordinator writes the registered
# field (run.sendersFile) and the gateway matches it on the key's id, so issue the key with --issue
# under the registration's `participant`. --bind is for an address the registrations do not hold.
#
# Why not Cloudflare Access service tokens: they cap at 50 per account. Measured 2026-09-21 — with
# 50 in existence the 51st create fails `org_has_exceeded_allowed_token_count`, and revoking one
# frees a slot at once, so it is a cap on tokens *existing*, not a rate limit. The docs say "these
# limits may be increased on Enterprise accounts", i.e. not self-serve at any price. A field of
# 100+ participants cannot be gated by them.
#
# Two files come out, and only one of them is a secret:
#   <out>              the gateway's lookup: sha256(key) -> participant id. NO key material.
#   <out>.secrets.csv  the keys themselves (0600). This is what gets handed out.
# The gateway never sees, logs or stores a key — only its digest — so a leak of the gateway's file
# does not let anyone in.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${ASCON_KEYS_FILE:-$HOME/ascon-participant-tokens/rpc-keys.json}"
PREFIX="${ASCON_KEY_PREFIX:-team}"
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
die() { echo "error: $*" >&2; exit 1; }

case "${1:-}" in ""|-h|--help) sed -n '2,31p' "$0"; exit 0;; esac
# --out is accepted anywhere, not only first: an option that silently does nothing when it is in
# the "wrong" place writes live credentials to a path the operator did not choose.
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in --out) OUT="${2:?--out needs a path}"; shift 2;; *) ARGS+=("$1"); shift;; esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
SECRETS="$OUT.secrets.csv"
mkdir -p "$(dirname "$OUT")"; chmod 700 "$(dirname "$OUT")" 2>/dev/null || true

case "${1:-}" in
  --list)
    [ -f "$OUT" ] || die "no keys file at $OUT"
    python3 -c "
import json,sys
d=json.load(open('$OUT'))
k=d.get('keys',{})
s=d.get('senders',{})
print(f'{len(k)} keys in $OUT')
for h,i in sorted(k.items(), key=lambda kv: kv[1]): print(f'  {i:16} sha256={h[:16]}…  bound by hand: ' + (', '.join(s.get(i,[])) or '-'))
print('(addresses from the coordinator\'s run.sendersFile are not listed here; they bind by the same id)')"
    exit $? ;;
  --revoke)
    [ -n "${2:-}" ] || die "usage: $0 --revoke <participant-id>"
    [ -f "$OUT" ] || die "no keys file at $OUT"
    python3 - "$OUT" "$2" <<'PY'
import json,sys
path,pid=sys.argv[1],sys.argv[2]
d=json.load(open(path)); k=d.get("keys",{})
hit=[h for h,i in k.items() if i==pid]
if not hit: sys.exit(f"no key for {pid}")
for h in hit: del k[h]
d.get("senders",{}).pop(pid, None)
json.dump(d, open(path,"w"), indent=1, ensure_ascii=False)
print(f"revoked {pid} ({len(hit)} key(s)); the gateway re-reads within 15 s")
PY
    exit $? ;;
  --issue)
    ID="${2:?usage: $0 --issue <participant-id>}"
    echo "$ID" | grep -qE '^[A-Za-z0-9._-]+$' || die "id must be letters, digits, . _ - (it goes into a CSV and a log line)"
    [ -f "$OUT" ] || die "no keys file at $OUT — use --generate first"
    umask 077
    python3 - "$OUT" "$SECRETS" "$ID" <<'ISSUEPY'
import json, secrets, hashlib, sys, datetime
out, sec, pid = sys.argv[1:4]
d = json.load(open(out)); keys = d["keys"]
# One key per id: the gateway's bucket, log line and sender binding are all keyed on it, so a second
# key under the same name would be a second credential nobody can revoke separately.
if pid in keys.values(): sys.exit(f"{pid} already has a key; --revoke it first to rotate")
key = "ascon_" + secrets.token_urlsafe(32)
keys[hashlib.sha256(key.encode()).hexdigest()] = pid
json.dump(d, open(out, "w"), indent=1)
with open(sec, "a") as f: f.write(",".join((pid, key, datetime.date.today().isoformat())) + "\n")
print(f"  issued {pid}; the key is the last line of {sec}")
ISSUEPY
    rc=$?; [ $rc -eq 0 ] && echo "  the gateway re-reads within 15 s — no restart"; exit $rc ;;
  --bind|--unbind)
    [ -n "${2:-}" ] || die "usage: $0 $1 <participant-id> <address>"
    [ "$1" = --unbind ] || [ -n "${3:-}" ] || die "usage: $0 --bind <participant-id> <address>"
    [ -f "$OUT" ] || die "no keys file at $OUT"
    python3 - "$OUT" "$1" "$2" "${3:-}" <<'BINDPY'
import json, re, sys
path, op, pid, addr = sys.argv[1:5]
d = json.load(open(path))
if pid not in d.get("keys", {}).values(): sys.exit(f"no key for {pid}")
senders = d.setdefault("senders", {})
mine = senders.get(pid, [])
if op == "--bind":
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", addr): sys.exit(f"not an address: {addr}")
    addr = addr.lower()
    # One address, one key: the gateway attributes and rate-limits by key, so an address two keys
    # could send from would be traded by whichever of them holds its private key.
    other = [i for i, a in senders.items() if i != pid and addr in a]
    if other: sys.exit(f"{addr} is already bound to {other[0]}; --unbind it there first")
    if addr not in mine: mine.append(addr)
    senders[pid] = mine
else:
    if addr:
        addr = addr.lower()
        if addr not in mine: sys.exit(f"{addr} is not bound to {pid}")
        mine.remove(addr)
    else:
        mine = []
    if mine: senders[pid] = mine
    else: senders.pop(pid, None)
json.dump(d, open(path, "w"), indent=1, ensure_ascii=False)
print(f"{pid} bound by hand: {', '.join(senders.get(pid, [])) or '-'}; the gateway re-reads within 15 s")
BINDPY
    exit $? ;;
  --add)
    N="${2:?usage: $0 --add <count>}"
    echo "$N" | grep -qE '^[0-9]+$' || die "count must be a number"
    [ -f "$OUT" ] || die "no keys file at $OUT — use --generate first"
    umask 077
    python3 - "$OUT" "$SECRETS" "$N" "$PREFIX" <<'ADDPY'
import json, secrets, hashlib, sys, datetime, re
out, sec, n, prefix = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
d = json.load(open(out)); keys = d["keys"]
# Continue the numbering rather than restarting it: a second `team-007` would make the ledger and
# the gateway log disagree about who that is.
pat = re.compile(re.escape(prefix) + r"-(\d+)$")
used = [int(m.group(1)) for i in keys.values() for m in [pat.fullmatch(i)] if m]
start = max(used, default=0) + 1
today = datetime.date.today().isoformat()
rows = []
for i in range(start, start + n):
    pid = "%s-%03d" % (prefix, i)
    key = "ascon_" + secrets.token_urlsafe(32)
    keys[hashlib.sha256(key.encode()).hexdigest()] = pid
    rows.append((pid, key, today))
json.dump(d, open(out, "w"), indent=1)
with open(sec, "a") as f:
    for r in rows: f.write(",".join(r) + "\n")
print("  added %d: %s .. %s" % (n, rows[0][0], rows[-1][0]))
print("  total %d keys in %s" % (len(keys), out))
ADDPY
    echo "  the gateway re-reads within 15 s — no restart"
    exit 0 ;;

  --generate)
    N="${2:?usage: $0 --generate <count>}"
    echo "$N" | grep -qE '^[0-9]+$' || die "count must be a number"
    [ -e "$OUT" ] && die "$OUT exists — move it aside rather than overwriting live credentials"
    umask 077
    python3 - "$OUT" "$SECRETS" "$N" "$PREFIX" <<'PY'
import json, secrets, hashlib, sys, datetime
out, sec, n, prefix = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
keys, rows = {}, []
today = datetime.date.today().isoformat()
for i in range(1, n + 1):
    pid = f"{prefix}-{i:03d}"
    # 32 bytes of urandom, url-safe. The `ascon_` prefix makes a leaked key greppable and tells
    # whoever finds it what it opens.
    key = "ascon_" + secrets.token_urlsafe(32)
    keys[hashlib.sha256(key.encode()).hexdigest()] = pid
    rows.append((pid, key, today))
json.dump({"note": "sha256(key) -> participant id. No key material here.",
           "generated": today, "keys": keys}, open(out, "w"), indent=1)
with open(sec, "w") as f:
    f.write("participant_id,key,issued\n")
    for r in rows: f.write(",".join(r) + "\n")
print(f"  lookup  {out}        ({len(keys)} keys, digests only)")
print(f"  secrets {sec}   (0600 — this is the handout)")
PY
    chmod 600 "$SECRETS" "$OUT" 2>/dev/null
    cat <<DONE

  Point the gateway at the lookup file and restart it:
    RPC_KEYS_FILE=$OUT

  Setting it makes X-ASCON-Key mandatory. Verify both directions before handing anything out:
    valid key   -> 200
    no/bad key  -> 403 {"code":-32001,"message":"missing or unknown X-ASCON-Key"}
DONE
    exit 0 ;;
esac
die "unknown option: $1"
