import { AppShell, PAGE_MAIN } from "@/components/AppShell";
import { MarkdownView } from "@/components/markdownView";
import { qaTopics } from "@/data/qa";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";

/**
 * The questions participants ask most, answered from the rules and the list of targets, at `/qa`.
 *
 * The first topic is how far an attack may go. The list of targets on ascon.dev is the authority
 * and is linked from every topic; this page is the reading of it, with the examples a participant
 * actually asks about. The text is `docs/qa/`, read at build time, for the same reason as the
 * update history: a second copy is a second thing to keep correct.
 *
 * One page rather than one per topic: a reader with a question scans for it, and the topics are
 * few. Each topic's `#` title is for somebody reading the file on GitHub; here the page has its
 * own title, and a topic begins at its first question.
 */
const MEASURE = "68ch";

export function QaPage() {
  const locale = useLocale();
  const topics = qaTopics(locale);

  return (
    <AppShell activePage="qa">
      <main style={{ ...PAGE_MAIN, maxWidth: 1040 }}>
        <h1
          style={{
            fontSize: "var(--text-2xl)",
            letterSpacing: "var(--tracking-tight)",
            fontWeight: 600,
            margin: "0 0 var(--space-3)",
          }}
        >
          {t("qa.title")}
        </h1>
        <p
          style={{
            margin: "0 0 var(--space-10)",
            maxWidth: MEASURE,
            lineHeight: 1.85,
            color: "var(--text-secondary)",
          }}
        >
          {t("qa.lede")}
        </p>

        {topics.length === 0 ? (
          <p style={{ color: "var(--text-tertiary)" }}>{t("qa.empty")}</p>
        ) : (
          topics.map((topic) => (
            <section
              key={topic.slug}
              id={topic.slug}
              style={{
                borderTop: "1px solid var(--border-subtle)",
                padding: "var(--space-6) 0",
              }}
            >
              <MarkdownView
                blocks={topic.blocks.filter(
                  (b) => !(b.kind === "heading" && b.level === 1),
                )}
              />
            </section>
          ))
        )}
      </main>
    </AppShell>
  );
}
