# Q&A

Answers to the questions participants ask most, written from the rules and the list of targets. The
dashboard's "Q&A" shows these files grouped by genre.

The pages on [ascon.dev](https://ascon.dev) are the authority. Where these pages and they disagree,
they win.

## Writing one

- One topic per file: `<number>-<name>.md` is the Japanese text, `<number>-<name>.en.md` its
  translation. Within a genre, topics are shown in number order
- The file opens with its genre as frontmatter; `genre` is one of the `key`s in `genres.json`

  ```
  ---
  genre: scope
  ---
  # The topic's title
  ```

- `#` is the topic's title (for readers on GitHub; the dashboard does not show it) and each `##` is a
  question. A question's heading is its anchor, so it has to be unique across the whole Q&A
- To add a genre, add `{ "key", "ja", "en" }` to `genres.json`; the file's order is the display
  order. A genre with no topic is not shown
- The syntax is the same subset as the update history (headings, paragraphs, bold, code, links,
  tables, lists, fenced code). `npm test`'s `dashboardMarkdown` checks that it renders

## Topics

| Genre | Topic | What it covers |
|---|---|---|
| Scope of exploitation | [The scope of exploitation](01-scope.en.md) | The criteria behind the list of targets (§3.1), and examples of attacks in and out of scope |
