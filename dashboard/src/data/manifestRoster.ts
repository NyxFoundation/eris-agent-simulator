// The roster a run's manifest.json carries. The coordinator rewrites the manifest with the full
// roster on every mid-period registration (ADR 0021 §2), and the public view serves it, so it is
// the one place the dashboard can read the current roster without reading all of events.jsonl
// (issue #181). Kept free of the `@core` alias so node's tests can import it.

export interface ManifestParticipant {
  id: string;
  address?: string;
  baseline?: boolean;
}

/** `participants` of a run's manifest.json; null when there is none or it does not parse. */
export function parseManifestParticipants(
  text: string | null,
): ManifestParticipant[] | null {
  if (!text) return null;
  try {
    const list = (JSON.parse(text) as { participants?: unknown }).participants;
    if (!Array.isArray(list)) return null;
    return list.flatMap((p): ManifestParticipant[] => {
      if (!p || typeof p !== "object") return [];
      const { id, address, baseline } = p as Record<string, unknown>;
      if (typeof id !== "string") return [];
      return [
        {
          id,
          ...(typeof address === "string" ? { address } : {}),
          ...(baseline === true ? { baseline: true } : {}),
        },
      ];
    });
  } catch {
    return null;
  }
}
