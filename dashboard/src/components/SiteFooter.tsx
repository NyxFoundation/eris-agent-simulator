// One line under every page: this is a read-only view, and -- in the public view -- that some of
// what a competition in progress holds is withheld, with the reason one "?" away. It sat at the
// foot of the sidebar until the sidebar went (issue #183).

import { useMode } from "@/data/mode";
import { InfoTip, TipText } from "@/design-system/InfoTip";
import { t } from "@/i18n/messages";

export function SiteFooter() {
  const mode = useMode();
  return (
    <footer
      style={{
        marginTop: "auto",
        padding: "14px var(--page-pad-x)",
        borderTop: "1px solid var(--border-subtle)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px",
        font: "var(--text-xs) var(--font-mono)",
        color: "var(--text-disabled)",
      }}
    >
      <span>
        {t("picker.readOnly")} · {t("picker.noSignIn")}
      </span>
      {mode.audience && (
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {" · "}
          {t("mode.audienceBadge")}
          <InfoTip label={t("mode.audienceBadge")}>
            <TipText>{t("mode.audienceNote")}</TipText>
          </InfoTip>
        </span>
      )}
    </footer>
  );
}
