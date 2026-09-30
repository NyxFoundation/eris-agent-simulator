// The runs/ index, re-polled so a run that starts (live) or completes while the page is open
// appears without a reload. Shared by the competition picker and the world switcher.

import { useEffect, useState } from "react";
import { listRuns, type RunIndexEntry } from "./runArtifacts";

const POLL_MS = 10_000;

/** null until the first answer; [] when the index could not be read. */
export function useRunIndex(): RunIndexEntry[] | null {
  const [entries, setEntries] = useState<RunIndexEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listRuns()
        .then((list) => {
          if (!cancelled) setEntries(list);
        })
        .catch(() => {
          if (!cancelled) setEntries((prev) => prev ?? []);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return entries;
}
