// Read one range of the registration spreadsheet as a Google service account, read-only.
//
// No client library: the service-account flow is one signed JWT exchanged for a bearer token, and
// pulling in googleapis for that would be the largest dependency of a bot that otherwise needs two.
// Share the spreadsheet with the service account's address as a viewer; nothing else is granted.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const b64url = (s) => Buffer.from(s).toString("base64url");

export function createSheetReader({ keyFile, spreadsheetId, range }) {
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!key.client_email || !key.private_key)
    throw new Error(`${keyFile} is not a service-account key (no client_email / private_key)`);
  let token = null;
  let expiresAt = 0;

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < expiresAt - 60) return token;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64url(
      JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${claim}`)
      .sign(key.private_key)
      .toString("base64url");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claim}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    token = body.access_token;
    expiresAt = now + (body.expires_in ?? 3600);
    return token;
  }

  /** The range's cells, first row = headers, as the Sheets API returns them. */
  return async function readValues() {
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
      `/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
    return (await res.json()).values ?? [];
  };
}
