// Optional local Blockscout explorer (npm run explorer, issue #31): the dashboard
// only deep-links to it, never depends on it. Availability is probed once per page
// load through the Vite proxy (/blockscout -> :3100) so browser CORS never applies;
// when the explorer is down the probe fails and every link simply stays plain text.

import { useEffect, useState } from "react";

const BLOCKSCOUT_URL =
  (import.meta.env.VITE_BLOCKSCOUT_URL as string | undefined) ??
  "http://localhost:3100";

let probe: Promise<boolean> | null = null;

function blockscoutAvailable(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch("/blockscout/api/v2/stats", {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Base URL for explorer links, or null while probing / when the explorer is down. */
export function useBlockscoutBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void blockscoutAvailable().then((ok) => {
      if (!cancelled && ok) setBase(BLOCKSCOUT_URL);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return base;
}

export const blockscoutTxUrl = (base: string, hash: string): string =>
  `${base}/tx/${hash}`;
export const blockscoutBlockUrl = (base: string, block: number): string =>
  `${base}/block/${block}`;
export const blockscoutAddressUrl = (base: string, address: string): string =>
  `${base}/address/${address}`;
