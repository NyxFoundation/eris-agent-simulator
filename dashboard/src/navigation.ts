/**
 * Client-side navigation. `path` may carry a query ("/explorer?q=0xabc"): the router matches on
 * the pathname alone, and a page that takes a parameter reads it off `window.location.search`.
 */
export function navigate(path: string): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** One query parameter of the current location, or null. */
export function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
