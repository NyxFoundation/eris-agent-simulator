// Pure pieces of the faucet bot: no Discord, no network, no files. Everything that decides whether a
// request is accepted lives here so it can be tested without a token.

// The same rules as ~/.claude/skills/devnet-register/scripts/register.sh. The values are spliced into
// a YAML file, so nothing outside these sets may get through.
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Discord usernames (the post-2023 unique handle): 2–32 of lowercase letters, digits, "_" and ".".
const DISCORD_USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

/**
 * What a participant typed into the form's "Discord ユーザー名" field, as the handle Discord knows.
 * People write "@name", "Name", "name#0" or a full-width "＠name"; all of those are the same account.
 * Returns null for anything that cannot be a username (a display name with spaces, an empty cell).
 */
export function normalizeUsername(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").trim();
  s = s.replace(/^@+/, "");
  s = s.replace(/#\d{1,4}$/, "");
  s = s.toLowerCase();
  return DISCORD_USERNAME_RE.test(s) ? s : null;
}

/**
 * The set of usernames the sheet admits, from a Sheets API `values` array (first row = headers).
 * `approvedHeader` / `approvedValue` are optional: when set, a row counts only if that column holds
 * exactly that value (e.g. a checkbox column reading "TRUE").
 */
export function sheetUsernames(values, { usernameHeader, approvedHeader, approvedValue }) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error("the sheet range returned no rows");
  const headers = values[0].map((h) => String(h ?? "").trim());
  const col = headers.indexOf(usernameHeader);
  if (col < 0) throw new Error(`no column headed "${usernameHeader}" in the sheet`);
  const okCol = approvedHeader ? headers.indexOf(approvedHeader) : -1;
  if (approvedHeader && okCol < 0)
    throw new Error(`no column headed "${approvedHeader}" in the sheet`);

  const admitted = new Set();
  const unreadable = [];
  for (const row of values.slice(1)) {
    if (okCol >= 0 && String(row[okCol] ?? "").trim() !== approvedValue) continue;
    const raw = row[col];
    if (raw === undefined || String(raw).trim() === "") continue;
    const name = normalizeUsername(String(raw));
    if (name) admitted.add(name);
    else unreadable.push(String(raw));
  }
  return { admitted, unreadable };
}

/**
 * Whether a /faucet request may be written, given what is already registered and claimed.
 * Returns { ok: true } or { ok: false, reason } with a reason fit to show the requester.
 */
export function checkRequest({ userId, agentId, address, registered, claims }) {
  if (claims[userId])
    return {
      ok: false,
      reason: `already-claimed`,
      existing: claims[userId],
    };
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, reason: "bad-agent-id" };
  if (!ADDRESS_RE.test(address)) return { ok: false, reason: "bad-address" };
  if (/^0x0{40}$/i.test(address)) return { ok: false, reason: "bad-address" };
  for (const e of registered) {
    if (e.id === agentId) return { ok: false, reason: "agent-id-taken" };
    if (String(e.address).toLowerCase() === address.toLowerCase())
      return { ok: false, reason: "address-taken" };
  }
  return { ok: true };
}

/** The lines appended to config/registrations.yaml, in the shape register.sh writes. */
export function registrationEntry({ agentId, address, date }) {
  if (!AGENT_ID_RE.test(agentId) || !ADDRESS_RE.test(address))
    throw new Error("refusing to write an unchecked entry");
  // No Discord name here: `description` reaches the public manifest. The mapping stays in claims.json.
  return `\n- id: ${agentId}\n  address: "${address}"\n  description: registered ${date} via the faucet bot\n`;
}

/** YYYY-MM-DD in Japan time, the date register.sh stamps. */
export function tokyoDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * A token's address from sdk/src/constants.local.ts, the way register.sh's `tok` finds it: the
 * first address within three lines of `<SYMBOL>: {`.
 */
export function tokenAddressFromConstants(source, symbol) {
  // Every `<SYMBOL>: {` line, not just the first: the file declares the type (`WETH: { address:
  // Address; … }`) before the value, and grep -A3 in register.sh looks past it the same way.
  const lines = source.split("\n");
  const head = new RegExp(`^\\s*${symbol}: \\{`);
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue;
    const m = /0x[0-9a-fA-F]{40}/.exec(lines.slice(i, i + 4).join("\n"));
    if (m) return m[0];
  }
  return null;
}

/** A uint256 as a decimal string with `decimals` places, trailing zeros trimmed. */
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * When the next segment starts, which is when a mid-day registration starts being scored. Segments
 * are cut every `segmentHours` from the period's start, and the period's directory is named for it
 * (2026-09-28T09-13-09-294Z).
 */
export function nextSegmentStart(period, segmentHours, now = Date.now()) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(period);
  if (!m) return null;
  const start = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  const step = segmentHours * 3_600_000;
  return new Date(start + Math.ceil((now - start) / step) * step);
}
