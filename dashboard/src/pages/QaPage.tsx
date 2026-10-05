import { AppShell, PAGE_MAIN } from "@/components/AppShell";
import { MarkdownView } from "@/components/markdownView";
import { qaGenres } from "@/data/qa";
import type { Block } from "@/data/markdownDoc";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";

/**
 * The questions participants ask most, answered from the rules and the list of targets, at `/qa`.
 *
 * Grouped by genre (docs/qa/genres.json), with the questions of every genre listed at the top so
 * a reader with one question finds it without scrolling. The first genre is how far an attack may
 * go: the list of targets on ascon.dev is the authority and is linked from the topic; this page
 * is the reading of it. The text is `docs/qa/`, read at build time, for the same reason as the
 * update history: a second copy is a second thing to keep correct.
 *
 * One page rather than one per topic: a reader scans for a question, and the topics are few. A
 * genre is a `<h2>` of the page, so a topic's `#` title (for somebody reading the file on GitHub)
 * is dropped and its `##` questions render one level down.
 */
const MEASURE = "68ch";

function underGenre(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.kind !== "heading") out.push(b);
    else if (b.level > 1) out.push({ ...b, level: b.level + 1 });
  }
  return out;
}

export function QaPage() {
  const locale = useLocale();
  const genres = qaGenres(locale);

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
            margin: "0 0 var(--space-8)",
            maxWidth: MEASURE,
            lineHeight: 1.85,
            color: "var(--text-secondary)",
          }}
        >
          {t("qa.lede")}
        </p>

        {genres.length === 0 ? (
          <p style={{ color: "var(--text-tertiary)" }}>{t("qa.empty")}</p>
        ) : (
          <>
            <nav
              aria-label={t("qa.contents")}
              style={{
                maxWidth: MEASURE,
                marginBottom: "var(--space-10)",
                padding: "var(--space-4) var(--space-5)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md, 8px)",
              }}
            >
              {genres.map((g) => (
                <div key={g.key} style={{ margin: "var(--space-2) 0" }}>
                  <a
                    href={`#genre-${g.key}`}
                    style={{
                      fontWeight: 650,
                      color: "var(--text-primary)",
                      textDecoration: "none",
                    }}
                  >
                    {g.label}
                  </a>
                  <ul
                    style={{
                      margin: "var(--space-1) 0 0",
                      paddingLeft: "1.2em",
                      lineHeight: 1.8,
                    }}
                  >
                    {g.topics.flatMap((topic) =>
                      topic.questions.map((q) => (
                        <li key={`${topic.slug}#${q.id}`}>
                          <a href={`#${q.id}`} style={{ color: "var(--text-link)" }}>
                            {q.text}
                          </a>
                        </li>
                      )),
                    )}
                  </ul>
                </div>
              ))}
            </nav>

            {genres.map((g) => (
              <section
                key={g.key}
                id={`genre-${g.key}`}
                style={{
                  borderTop: "1px solid var(--border-subtle)",
                  padding: "var(--space-6) 0",
                }}
              >
                <h2
                  style={{
                    fontSize: "var(--text-xl)",
                    letterSpacing: "var(--tracking-tight)",
                    fontWeight: 600,
                    margin: "0 0 var(--space-4)",
                  }}
                >
                  {g.label}
                </h2>
                {g.topics.map((topic) => (
                  <MarkdownView key={topic.slug} blocks={underGenre(topic.blocks)} />
                ))}
              </section>
            ))}
          </>
        )}
      </main>
    </AppShell>
  );
}
