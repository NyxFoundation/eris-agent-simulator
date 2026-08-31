// Which language the dashboard speaks. One store, read by every page and by the data-layer
// builders (via t()), persisted per browser. The default follows the browser's language.

import { useSyncExternalStore } from "react";

export type Locale = "en" | "ja";

const STORAGE_KEY = "eris.lang";

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ja") return stored;
  } catch {
    // no storage — fall through to the browser language
  }
  return typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("ja")
    ? "ja"
    : "en";
}

let locale: Locale = initialLocale();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // per-viewer convenience only
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
}
