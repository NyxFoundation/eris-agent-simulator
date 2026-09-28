// Where a /blockscout request may be forwarded. The request path is the caller's, and the dashboard
// is public: resolving it against the explorer's URL let a scheme-relative path
// ("/blockscout//ascon-prometheus:9090/…") name another origin, which made this server a proxy into
// the host's internal network (Prometheus answered through it) and out to the internet. The browser
// only ever reads the explorer's API (dashboard/src/data/blockscout.ts), so that is all that passes:
// the configured origin, GET or HEAD, under /api/v2/.
export const EXPLORER_API_PREFIX = "/api/v2/";

export function explorerTarget(
  rest: string,
  query: string | undefined,
  method: string | undefined,
  base: string,
): URL | null {
  if (method !== "GET" && method !== "HEAD") return null;
  let origin: URL;
  let target: URL;
  try {
    origin = new URL(base);
    target = new URL(rest + (query ? `?${query}` : ""), origin);
  } catch {
    return null;
  }
  if (target.origin !== origin.origin) return null;
  if (!target.pathname.startsWith(EXPLORER_API_PREFIX)) return null;
  return target;
}
