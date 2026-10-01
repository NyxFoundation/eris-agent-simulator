#!/usr/bin/env python3
"""Static safety scan for a submitted agent (ZIP or directory), run BEFORE accepting it / building the
per-team image. Defense-in-depth in front of the runtime container caps (infra/docker-agent): catch the
obvious abuse at submission so it never reaches the box.

  scan-submission.py <agent.zip | dir> [--json] [--max-unzip-mb 50] [--max-files 2000]

Exit code 0 = accept (no BLOCK findings), 1 = reject (>=1 BLOCK). WARN/INFO never fail the exit; they are
for the operator to eyeball. Not a sandbox and not exhaustive -- the runtime caps are the real boundary;
this just rejects the cheap, obvious stuff (zip bombs, native blobs, egress/exec, install hooks, secrets).
"""
import hashlib, stat
import sys, os, re, zipfile, json, tempfile, shutil

MAX_UNZIP_MB = 50
MAX_FILES = 2000
MAX_FILE_MB = 8
CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".json")
# Issue #40 T6: a bundle may now carry contracts. Deployment is a permitted capability, so the
# scanner has to have an opinion about the two shapes it arrives in rather than tripping over them:
# Solidity sources (harmless text, but worth naming so an operator knows contracts are in play) and
# forge artifacts (a JSON whose `bytecode.object` is one enormous hex string -- scanning it as code
# would fire the "large hex blob" rule on every honest submission).
SOURCE_EXT = (".sol",)
# EIP-3860 caps initcode at 49,152 bytes; EIP-170 caps deployed code at 24,576. Anything past the
# initcode limit cannot deploy at all, so it is a mistake rather than an attack -- but it is also
# exactly what a bundle-size attack looks like, so say so.
MAX_INITCODE_BYTES = 49152
BINARY_EXT = (".node", ".so", ".dll", ".exe", ".dylib", ".wasm", ".bin", ".a", ".o", ".class", ".pyc")

findings = []  # (severity, path, message)
def add(sev, path, msg): findings.append((sev, path, msg))

# --- source-code red flags (participant agent code runs as a full node process) ---
CODE_RULES = [
    ("BLOCK", r"child_process|require\(\s*['\"]child_process|node:child_process|execSync|spawnSync|\.exec\(|\.spawn\(",
     "spawns external processes (solc/shell/fork-bomb surface)"),
    ("BLOCK", r"\beval\s*\(|new\s+Function\s*\(|require\(\s*['\"]vm['\"]|node:vm",
     "dynamic code execution (eval/Function/vm)"),
    ("BLOCK", r"require\(\s*['\"](net|dgram|dns|tls|http2)['\"]|node:(net|dgram|dns|tls|http2)",
     "raw network sockets / DNS (egress beyond the RPC)"),
    ("WARN", r"\bfetch\s*\(|require\(\s*['\"]https?['\"]|node:https?|\baxios\b|node-fetch|\bundici\b|new\s+WebSocket|require\(\s*['\"]ws['\"]",
     "outbound HTTP/WebSocket (external LLM/oracle/exfiltration -- confirm target is the allowed RPC/LLM)"),
    ("BLOCK", r"require\(\s*['\"]fs['\"]|node:fs|writeFileSync|createWriteStream|fs\.write|mkdirSync|rmSync|unlinkSync",
     "filesystem writes (disk-fill / tampering)"),
    ("BLOCK", r"anvil_[a-zA-Z]+|hardhat_[a-zA-Z]+|evm_(setBalance|snapshot|revert|mine|setAccountStorage)|setStorageAt|impersonateAccount|setBalance",
     "chain cheatcode / privileged RPC (only valid on the dev chain; forbidden)"),
    ("WARN", r"process\.env|process\.mainModule|globalThis\.process",
     "reads process env (may try to exfiltrate operator secrets)"),
    ("WARN", r"require\(\s*['\"]worker_threads|node:worker_threads|new\s+Worker\(",
     "worker threads (CPU multiplication -- bounded by --cpus but note it)"),
    ("BLOCK", r"require\(\s*['\"]os['\"].*\)|node:os|/proc/|/sys/|readdirSync\(\s*['\"]/",
     "host/OS introspection or reading absolute host paths"),
]
SECRET_RE = re.compile(r"(0x[a-fA-F0-9]{64})|(xox[baprs]-[A-Za-z0-9-]{10,})|(sk-[A-Za-z0-9]{20,})|(AKIA[0-9A-Z]{16})")
MINER_RE = re.compile(r"stratum\+tcp|xmrig|coinhive|cryptonight|ethminer|nicehash", re.I)

def scan_code(path, text):
    for sev, pat, msg in CODE_RULES:
        if re.search(pat, text):
            add(sev, path, msg)
    if SECRET_RE.search(text): add("WARN", path, "looks like a hardcoded secret/key/token")
    if MINER_RE.search(text): add("BLOCK", path, "crypto-miner signature")
    # crude obfuscation / huge base64 blob
    if re.search(r"['\"][A-Za-z0-9+/=]{800,}['\"]", text):
        add("WARN", path, "large base64/hex blob (possible packed payload)")

def scan_forge_artifact(path, text):
    """A forge artifact carries creation bytecode, which is the point. Check the shape and the size;
    do not run the source-code rules over a hex blob."""
    try: art = json.loads(text)
    except Exception: return False
    bc = art.get("bytecode")
    obj = bc.get("object") if isinstance(bc, dict) else bc
    if not isinstance(obj, str) or not obj.startswith("0x"): return False
    nbytes = (len(obj) - 2) // 2
    if nbytes == 0:
        add("WARN", path, "forge artifact with empty bytecode (abstract contract or interface?)")
    elif nbytes > MAX_INITCODE_BYTES:
        add("WARN", path, f"creation bytecode {nbytes} bytes exceeds the EIP-3860 initcode limit ({MAX_INITCODE_BYTES}); this cannot deploy")
    else:
        add("INFO", path, f"forge artifact, {nbytes} bytes of creation bytecode (deployment is permitted; issue #40)")
    return True

# --- team dependencies ------------------------------------------------------------------------
# Dockerfile.team fetches a team's deps in a stage that runs no participant code (npm ci
# --ignore-scripts, pip download --only-binary) and installs them in a stage with no network. That
# only holds if every dependency comes from the public registry by name and version: a git/URL/path
# source, a project-level registry override or a requirements option line all move "where the bytes
# come from" back into the participant's hands. These are BLOCK, not WARN.
NPM_REGISTRY = "https://registry.npmjs.org/"
REGISTRY_CONFIG_FILES = (".npmrc", ".yarnrc", ".yarnrc.yml", "pip.conf", "pip.ini", ".pydistutils.cfg")

def scan_package_json(path, text, has_lock):
    try: pkg = json.loads(text)
    except Exception: return add("BLOCK", path, "package.json does not parse")
    scripts = pkg.get("scripts", {}) or {}
    for hook in ("preinstall", "install", "postinstall", "prepare", "prepublish"):
        if hook in scripts:
            add("BLOCK", path, f"npm '{hook}' lifecycle script (supply-chain execution at build): {scripts[hook][:60]}")
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {}),
            **(pkg.get("optionalDependencies") or {})}
    # The bundle root's package.json is written by bundle:agent (`@eris/sdk: file:./sdk`) and is
    # never copied by accept-submission.sh; only a package.json inside the agent is installed.
    bundle_root = path.replace(os.sep, "/") == "package.json"
    for d, v in deps.items():
        if isinstance(v, str) and re.match(r"(git|https?|file|link|npm:|github:|bitbucket:|gist:|[\w.-]+/[\w.-]+$|\.\.?/|/)", v):
            add("WARN" if bundle_root else "BLOCK", path, f"non-registry dependency '{d}': {v}")
    if deps and not bundle_root and not has_lock:
        add("BLOCK", path, "package.json declares dependencies but has no package-lock.json beside it (the team build runs `npm ci`)")
    if len(deps) > 60: add("WARN", path, f"large dependency set ({len(deps)})")

def scan_package_lock(path, text):
    """Every installed package must come from the public registry with an integrity hash. Only the
    v2/v3 `packages` map lists every entry with its source; a v1 lock keeps them under a nested
    `dependencies` tree this does not walk, so it would pass with nothing checked. Require v2+.
    An entry without `resolved` is not "fine by default": npm fills the gap from whatever the
    registry/spec says at install time, so it is BLOCK too. Exempt: the root (""), and entries
    `inBundle` (their bytes ship inside a parent tarball that is itself integrity-checked)."""
    try: lock = json.loads(text)
    except Exception: return add("BLOCK", path, "package-lock.json does not parse")
    if not isinstance(lock, dict): return add("BLOCK", path, "package-lock.json is not a JSON object")
    ver = lock.get("lockfileVersion")
    pkgs = lock.get("packages")
    if not isinstance(ver, int) or ver < 2 or not isinstance(pkgs, dict):
        return add("BLOCK", path, f"lockfileVersion {ver!r} without a `packages` map (need v2/v3; regenerate with npm >= 7)")
    for name, ent in pkgs.items():
        if not name: continue
        if not isinstance(ent, dict):
            add("BLOCK", path, f"'{name}' entry is not an object"); continue
        if ent.get("link"):
            add("BLOCK", path, f"'{name}' is a local link, not a registry package"); continue
        if ent.get("inBundle"): continue
        res = ent.get("resolved")
        if not (isinstance(res, str) and res.startswith(NPM_REGISTRY)):
            add("BLOCK", path, f"'{name}' does not resolve to {NPM_REGISTRY}: {str(res)[:80]}")
        elif not ent.get("integrity"):
            add("BLOCK", path, f"'{name}' has no integrity hash")

REQ_LINE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?==[A-Za-z0-9.!+_-]+(\s*;[^#]*)?((\s+--hash=sha256:[0-9a-f]{64})+)$")

def scan_requirements(path, text):
    """Every requirement is `name==version --hash=sha256:...` and nothing else: no option lines
    (--index-url / -f / -e / -r / -c ...), no URLs, no paths. The team build installs with
    --require-hashes --only-binary=:all:, which fails on these anyway; failing here says why."""
    joined = re.sub(r"\\\n", " ", text)
    for raw in joined.splitlines():
        line = re.sub(r"(^|\s)#.*$", "", raw).strip()
        if not line: continue
        if not REQ_LINE.match(line):
            add("BLOCK", path, f"requirement is not a hash-pinned registry release (`name==version --hash=sha256:...`): {line[:80]}")

# --- operator-shipped code inside a submission -------------------------------------------------
# `npm run bundle:agent` packs the SDK, the runtime and the shared lib alongside the participant's
# agent ("the entire sdk + runtime + lib + one agent"). Scanning those bodies rejects every honest
# submission: agents/runtime/llm.ts spawns processes, state.ts writes files, sdk/src/config.ts reads
# env -- all of it operator code doing its job. Measured on a stock bundle: 20 BLOCK, every one of
# them ours, none in the participant's directory.
#
# Skipping them outright would be worse: a participant can edit the vendored copy. So compare each
# against the repo and skip only the bodies that are byte-identical; anything altered or unknown is
# a BLOCK, which is the finding that actually matters here.
VENDORED = (("sdk/", "sdk/"), ("agents/runtime/", "example/agents/runtime/"), ("agents/lib/", "example/agents/lib/"))
REPO_ROOT = os.environ.get("ERIS_REPO") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def vendored_ref(rel):
    """Repo path this bundled file should be identical to, or None if it is not operator code."""
    r = rel.replace(os.sep, "/")
    for prefix, repo_prefix in VENDORED:
        if r.startswith(prefix):
            return os.path.join(REPO_ROOT, repo_prefix + r[len(prefix):])
    return None

def check_vendored(rel, fp):
    """True when this file is operator code and needs no body scan. Flags tampering."""
    ref = vendored_ref(rel)
    if ref is None:
        return False
    if not os.path.exists(ref):
        add("BLOCK", rel, "file under an operator-shipped path that the repo does not have (added to the vendored runtime?)")
        return True
    h = lambda q: hashlib.sha256(open(q, "rb").read()).hexdigest()
    try:
        if h(fp) != h(ref):
            add("BLOCK", rel, "operator-shipped file MODIFIED (the vendored sdk/runtime must be byte-identical to the distributed one)")
    except OSError:
        add("WARN", rel, "could not read operator-shipped file to compare")
    return True

def walk_dir(root):
    total = 0; nfiles = 0
    for dp, dns, fns in os.walk(root):
        # os.walk lists a symlinked directory under dns and does not descend into it; a symlinked
        # file is under fns and open() would read through it. Either way the tree being scanned is
        # not the tree that would be copied, so reject rather than follow.
        for dn in dns:
            if os.path.islink(os.path.join(dp, dn)):
                add("BLOCK", os.path.relpath(os.path.join(dp, dn), root), "symlink in submission (only regular files and directories are accepted)")
        for fn in fns:
            fp = os.path.join(dp, fn); rel = os.path.relpath(fp, root)
            nfiles += 1
            if os.path.islink(fp) or not os.path.isfile(fp):
                add("BLOCK", rel, "symlink or special file in submission (only regular files and directories are accepted)"); continue
            try: sz = os.path.getsize(fp)
            except OSError: continue
            total += sz
            low = fn.lower()
            if check_vendored(rel, fp): continue
            if low.endswith(BINARY_EXT): add("BLOCK", rel, "binary/native artifact in submission")
            if sz > MAX_FILE_MB * 1024 * 1024: add("WARN", rel, f"large file ({sz//1024//1024} MB)")
            if fn in REGISTRY_CONFIG_FILES:
                add("BLOCK", rel, "package-manager config file (would redirect where team dependencies are fetched from)")
            elif fn == "npm-shrinkwrap.json" and "node_modules" not in rel:
                # `npm ci` prefers npm-shrinkwrap.json over package-lock.json, so a benign lock next
                # to a shrinkwrap would be the one scanned and the other the one installed. Blocked
                # rather than scanned: there is no reason for an agent to ship one.
                add("BLOCK", rel, "npm-shrinkwrap.json (npm ci would install from it instead of package-lock.json; ship package-lock.json only)")
            elif fn == "package.json":
                scan_package_json(rel, open(fp, errors="ignore").read(), os.path.isfile(os.path.join(dp, "package-lock.json")))
            elif fn == "package-lock.json" and "node_modules" not in rel:
                scan_package_lock(rel, open(fp, errors="ignore").read())
            elif fn == "requirements.txt":
                scan_requirements(rel, open(fp, errors="ignore").read())
            elif low.endswith(SOURCE_EXT):
                add("INFO", rel, "Solidity source (contracts in a submission are permitted; what bounds them is the gas budget, rules §2.6)")
            elif low.endswith(".json") and "node_modules" not in rel and scan_forge_artifact(rel, open(fp, errors="ignore").read()):
                pass
            elif low.endswith(CODE_EXT) and "node_modules" not in rel:
                scan_code(rel, open(fp, errors="ignore").read())
            elif "node_modules" in rel and low.endswith(CODE_EXT[:5]):
                pass  # skip scanning vendored deps' bodies, but their presence is noted below
    if nfiles > MAX_FILES: add("BLOCK", "(archive)", f"too many files ({nfiles} > {MAX_FILES})")
    if total > MAX_UNZIP_MB * 1024 * 1024: add("BLOCK", "(archive)", f"unpacked too large ({total//1024//1024} MB > {MAX_UNZIP_MB})")
    if os.path.isdir(os.path.join(root, "node_modules")): add("WARN", "node_modules/", "vendored node_modules present (deps should be installed in a sandboxed build, not shipped)")
    return total, nfiles

def safe_extract(zf, dest):
    # zip-bomb + path-traversal guards
    comp = sum(i.compress_size for i in zf.infolist()) or 1
    uncomp = sum(i.file_size for i in zf.infolist())
    if uncomp > MAX_UNZIP_MB * 1024 * 1024: add("BLOCK", "(archive)", f"declared unpacked size {uncomp//1024//1024} MB > {MAX_UNZIP_MB}")
    if uncomp / comp > 100: add("BLOCK", "(archive)", f"suspicious compression ratio {uncomp/comp:.0f}x (zip bomb)")
    for i in zf.infolist():
        if i.filename.startswith("/") or ".." in i.filename.split("/"):
            add("BLOCK", i.filename, "path traversal / absolute path in archive"); continue
        # zipfile writes a symlink entry out as a small file holding the target path, so the body
        # scan below sees harmless text -- while `unzip` (accept-submission.sh) creates a real link
        # and the copy follows it into another team's directory. Only regular files and
        # directories may enter.
        kind = (i.external_attr >> 16) & 0o170000
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            what = "symlink" if kind == stat.S_IFLNK else f"special file (mode {kind:o})"
            add("BLOCK", i.filename, f"{what} in archive (only regular files and directories are accepted)"); continue
        zf.extract(i, dest)

def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if not a.startswith("--")]
    if not args: sys.exit("usage: scan-submission.py <agent.zip|dir> [--json]")
    src = args[0]
    tmp = None
    try:
        if os.path.isdir(src):
            root = src
        elif zipfile.is_zipfile(src):
            tmp = tempfile.mkdtemp(prefix="scan-");
            with zipfile.ZipFile(src) as zf: safe_extract(zf, tmp)
            root = tmp
        else:
            sys.exit("not a zip or directory: " + src)
        walk_dir(root)
        # require the agent entrypoint exists somewhere in the tree
        has_agent = any("agent.ts" in fns for _, _, fns in os.walk(root))
        if not has_agent: add("WARN", "(archive)", "no agent.ts found at any level")
    finally:
        if tmp: shutil.rmtree(tmp, ignore_errors=True)

    order = {"BLOCK": 0, "WARN": 1, "INFO": 2}
    findings.sort(key=lambda f: order.get(f[0], 3))
    blocks = sum(1 for f in findings if f[0] == "BLOCK")
    if as_json:
        print(json.dumps({"accept": blocks == 0, "blocks": blocks,
                          "findings": [{"severity": s, "path": p, "message": m} for s, p, m in findings]}, ensure_ascii=False, indent=2))
    else:
        print(f"=== submission scan: {src} ===")
        for s, p, m in findings: print(f"  [{s}] {p}: {m}")
        print(f"--- {blocks} BLOCK, {sum(1 for f in findings if f[0]=='WARN')} WARN -> {'REJECT' if blocks else 'ACCEPT'}")
    sys.exit(1 if blocks else 0)

if __name__ == "__main__":
    main()
