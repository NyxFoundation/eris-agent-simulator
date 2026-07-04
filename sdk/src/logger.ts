// JSON シリアライズ共通ヘルパ（bigint を decimal string 化）。環境(core)のログと
// agent の自己申告ログ（runs/<id>/agents/<id>.jsonl）の両方が同じ整形で書くために sdk に置く。
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    space,
  );
}
