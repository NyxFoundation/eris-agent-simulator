import { AppShell, PAGE_MAIN } from "@/components/AppShell";
import { MarkdownView } from "@/components/markdownView";
import { updateEntries, updateEntry } from "@/data/updates";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";

/**
 * The environment's update history: an index of entries at `/updates`, one entry at
 * `/updates/<YYYY-MM-DD>`.
 *
 * The guide always describes the current environment, so somebody who read it last week has no way
 * to see what moved; these pages are that diff, and a participant has to be able to read them where
 * they already are. The text is `docs/updates/`, read at build time: a second copy is a second thing
 * to keep correct, and the one that drifts is the one nobody is looking at.
 *
 * Two levels rather than one page, because entries accumulate: a year of them on one page is a page
 * nobody scrolls to the bottom of, and the thing a reader wants is one dated entry.
 */
const MEASURE = "68ch";

function Index() {
  const locale = useLocale();
  const entries = updateEntries(locale);

  return (
    <>
      <h1
        style={{
          fontSize: "var(--text-2xl)",
          letterSpacing: "var(--tracking-tight)",
          fontWeight: 600,
          margin: "0 0 var(--space-3)",
        }}
      >
        {t("updates.title")}
      </h1>
      <p
        style={{
          margin: "0 0 var(--space-10)",
          maxWidth: MEASURE,
          lineHeight: 1.85,
          color: "var(--text-secondary)",
        }}
      >
        {t("updates.lede")}
      </p>

      {entries.length === 0 ? (
        <p style={{ color: "var(--text-tertiary)" }}>{t("updates.empty")}</p>
      ) : (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            maxWidth: MEASURE,
          }}
        >
          {entries.map((e) => (
            <li
              key={e.slug}
              style={{
                borderTop: "1px solid var(--border-subtle)",
                padding: "var(--space-6) 0",
              }}
            >
              <a
                href={`/updates/${e.slug}`}
                style={{
                  display: "block",
                  color: "inherit",
                  textDecoration: "none",
                }}
              >
                <time
                  dateTime={e.slug}
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  {e.slug}
                </time>
                <div
                  style={{
                    fontSize: "var(--text-md)",
                    fontWeight: 650,
                    color: "var(--text-link)",
                    marginBottom: "var(--space-2)",
                    lineHeight: 1.4,
                  }}
                >
                  {e.title}
                </div>
                <p
                  style={{
                    margin: 0,
                    lineHeight: 1.8,
                    color: "var(--text-secondary)",
                  }}
                >
                  {e.summary}
                </p>
              </a>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Entry({ entrySlug }: { entrySlug: string }) {
  const locale = useLocale();
  const entry = updateEntry(locale, entrySlug);

  if (!entry) {
    return (
      <>
        <h1
          style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-4)" }}
        >
          {t("updates.notFound")}
        </h1>
        <a href="/updates" style={{ color: "var(--text-link)" }}>
          {t("updates.backToIndex")}
        </a>
      </>
    );
  }

  return (
    <>
      <a
        href="/updates"
        style={{
          display: "inline-block",
          marginBottom: "var(--space-6)",
          fontSize: "var(--text-sm)",
          color: "var(--text-link)",
        }}
      >
        {t("updates.backToIndex")}
      </a>
      <MarkdownView blocks={entry.blocks} />
    </>
  );
}

export function UpdatesPage({ entrySlug }: { entrySlug?: string }) {
  return (
    <AppShell activePage="updates">
      <main style={{ ...PAGE_MAIN, maxWidth: 1040 }}>
        {entrySlug ? <Entry entrySlug={entrySlug} /> : <Index />}
      </main>
    </AppShell>
  );
}
