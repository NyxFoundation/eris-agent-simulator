#!/usr/bin/env python3
"""Static safety scan for a submitted agent (ZIP or directory), run BEFORE accepting it / building the
per-team image. Defense-in-depth in front of the runtime container caps (infra/docker-agent): catch the
obvious abuse at submission so it never reaches the box.

  scan-submission.py <agent.zip | dir> [--json] [--max-unzip-mb 50] [--max-files 2000]

Exit code 0 = accept (no BLOCK findings), 1 = reject (>=1 BLOCK). WARN/INFO never fail the exit; they are
for the operator to eyeball. Not a sandbox and not exhaustive -- the runtime caps are the real boundary;
this just rejects the cheap, obvious stuff (zip bombs, native blobs, egress/exec, install hooks, secrets).
"""
import sys, os, re, zipfile, json, tempfile, shutil

MAX_UNZIP_MB = 50
MAX_FILES = 2000
MAX_FILE_MB = 8
CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".json")
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

def scan_package_json(path, text):
    try: pkg = json.loads(text)
    except Exception: return add("WARN", path, "package.json does not parse")
    scripts = pkg.get("scripts", {}) or {}
    for hook in ("preinstall", "install", "postinstall", "prepare", "prepublish"):
        if hook in scripts:
            add("BLOCK", path, f"npm '{hook}' lifecycle script (supply-chain execution at build): {scripts[hook][:60]}")
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    for d, v in deps.items():
        if isinstance(v, str) and re.match(r"(git|https?|file|github:|\.\.?/)", v):
            add("WARN", path, f"non-registry dependency '{d}': {v}")
    if len(deps) > 60: add("WARN", path, f"large dependency set ({len(deps)})")

def walk_dir(root):
    total = 0; nfiles = 0
    for dp, _, fns in os.walk(root):
        for fn in fns:
            fp = os.path.join(dp, fn); rel = os.path.relpath(fp, root)
            nfiles += 1
            try: sz = os.path.getsize(fp)
            except OSError: continue
            total += sz
            low = fn.lower()
            if low.endswith(BINARY_EXT): add("BLOCK", rel, "binary/native artifact in submission")
            if sz > MAX_FILE_MB * 1024 * 1024: add("WARN", rel, f"large file ({sz//1024//1024} MB)")
            if fn == "package.json":
                scan_package_json(rel, open(fp, errors="ignore").read())
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
