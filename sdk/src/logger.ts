// Shared JSON serialization helper (renders bigint as a decimal string). Placed in the sdk so that
// both the environment's (core) logs and the agent's self-reported logs (runs/<id>/agents/<id>.jsonl) write with the same formatting.
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    space,
  );
}
