// "Which one of these is mine?"
//
// The standings answer that by being a list of names to click. Where they are not posted (rules
// §4.7, the trial environment) there is no list, and the only ways to an agent's page were a wallet
// on the scenario board or a typed URL — for the one reader who most needs it, a participant who
// wants to know whether their own transactions landed (issue #84 G).
//
// So: a name, or the address they send from. A name or address the roster knows opens that agent's
// page. Anything else goes to the transaction list filtered by what was typed, which is the honest
// answer for a sender the roster does not know — ADR 0021 records those transactions under their
// address, and they are a participant's own until their registration lands.
//
// It is a lookup, not a ranking, so it stays on the page in every mode.

import { useMemo, useState } from "react";
import { Panel } from "@/components/competitionUi";
import { t } from "@/i18n/messages";
import { navigate } from "@/navigation";

const INPUT: React.CSSProperties = {
  flex: "1 1 260px",
  minWidth: 0,
  padding: "7px 10px",
  font: "var(--text-sm) var(--font-mono)",
  color: "var(--text-primary)",
  background: "var(--bg-surface-raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
};

const BUTTON: React.CSSProperties = {
  font: "var(--text-xs) var(--font-mono)",
  padding: "7px 12px",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-link)",
  cursor: "pointer",
};

/** The agent a term names, when the roster knows it: by id, or by the wallet it sends from. */
export function resolveAgent(
  term: string,
  addressByAgent: Record<string, string>,
): string | null {
  const q = term.trim().toLowerCase();
  if (!q) return null;
  for (const id of Object.keys(addressByAgent))
    if (id.toLowerCase() === q) return id;
  for (const [id, address] of Object.entries(addressByAgent))
    if (address.toLowerCase() === q) return id;
  return null;
}

export function FindAgent({
  addressByAgent,
}: {
  /** agent id -> wallet address, from whichever scenarios recorded one. */
  addressByAgent: Record<string, string>;
}) {
  const [term, setTerm] = useState("");
  const match = useMemo(
    () => resolveAgent(term, addressByAgent),
    [term, addressByAgent],
  );
  const typed = term.trim();

  const go = () => {
    if (!typed) return;
    if (match) {
      navigate(`/agent/${encodeURIComponent(match)}`);
      return;
    }
    // Not on the roster: the transactions are what there is, and the explorer searches them by
    // address or hash. A sender nobody registered is recorded under its address (ADR 0021 §2).
    navigate(`/explorer?q=${encodeURIComponent(typed)}`);
  };

  return (
    <Panel title={t("home.find.title")} subtitle={t("home.find.subtitle")}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "10px",
          padding: "12px 16px",
        }}
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          placeholder={t("home.find.placeholder")}
          aria-label={t("home.find.title")}
          style={INPUT}
        />
        <button type="button" onClick={go} style={BUTTON} disabled={!typed}>
          {t("home.find.go")}
        </button>
      </div>
      {typed && (
        <p
          style={{
            margin: 0,
            padding: "0 16px 12px",
            font: "var(--text-xs) var(--font-sans)",
            color: "var(--text-tertiary)",
            lineHeight: 1.6,
          }}
        >
          {match
            ? t("home.find.address", { id: match })
            : t("home.find.noMatch")}
        </p>
      )}
    </Panel>
  );
}
