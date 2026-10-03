import { useMemo } from "react";
import { AppShell, PAGE_MAIN } from "@/components/AppShell";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { updatesUrl } from "@/data/competitionInfo";
import { headings, parseMarkdown, slug } from "@/data/markdownDoc";
import { MarkdownView } from "@/components/markdownView";
import updatesJa from "../../../docs/competition-updates.md?raw";
import updatesEn from "../../../docs/competition-updates.en.md?raw";

/**
 * The environment's update history, rendered here rather than linked out to the repository.
 *
 * The guide always describes the current environment, so somebody who read it last week has no way
 * to see what moved; this page is that diff, and a participant has to be able to read it where they
 * already are. The text is the repository's own file, imported at build time: a second copy is a
 * second thing to keep correct, and the one that drifts is the one nobody is looking at.
 */
export function UpdatesPage() {
  const locale = useLocale();
  const blocks = useMemo(
    () => parseMarkdown(locale === "en" ? updatesEn : updatesJa),
    [locale],
  );
  // The dated entries are the `##` headings; the page's own `#` title is rendered as the heading.
  const toc = useMemo(
    () => headings(blocks).filter((h) => h.level === 2),
    [blocks],
  );

  return (
    <AppShell activePage="updates">
      <main style={{ ...PAGE_MAIN, maxWidth: 900 }}>
        {toc.length > 1 && (
          <nav
            aria-label={t("updates.toc")}
            style={{
              margin: "0 0 24px",
              padding: "12px 14px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                marginBottom: 8,
              }}
            >
              {t("updates.toc")}
            </div>
            {toc.map((h) => (
              <a
                key={h.text}
                href={`#${slug(h.text)}`}
                style={{
                  display: "block",
                  padding: "3px 0",
                  color: "var(--link)",
                  fontSize: 14,
                }}
              >
                {h.text}
              </a>
            ))}
          </nav>
        )}
        <MarkdownView blocks={blocks} />
        <p style={{ marginTop: 32, fontSize: 13, color: "var(--text-muted)" }}>
          <a
            href={updatesUrl(locale)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--link)", textDecoration: "underline" }}
          >
            {t("updates.source")}
          </a>
        </p>
      </main>
    </AppShell>
  );
}
