# Documentation style guide

This guide sets the writing and layout rules for every Markdown file in the repository: the README, the pages under `docs/`, the changelog, the issue and pull request templates and the architecture decision records. It asks for plain Markdown and nothing else. No documentation framework, site generator or editor plugin is required.

The rules serve one aim. A reader should be able to trust a page without checking it. Each rule removes something that makes a page harder to trust: a vague claim, an unexplained number, a term that changes meaning between pages, or a sentence that sounds good and says nothing.

## Principles

1. State what the software does, using its real names, values and limits.
2. Back every claim. A number needs a source file. A guarantee needs a test or a code path.
3. Say what the software does not do, next to the feature it limits.
4. Describe the current release. Planned work belongs in `docs/ROADMAP.md` and nowhere else.
5. Use one term for one concept and define it once in `docs/GLOSSARY.md`.
6. Cut any sentence that does not help a reader decide, act or understand.

## Voice

Write in the present tense and the active voice, and name the actor. "OCC redacts the match" is clearer than "the match is redacted". Call the product OCC after the first mention, and address the reader as "you" in instructions.

Make each sentence as short as its idea allows. Most will run 10 to 25 words. A longer sentence is fine when it carries a single idea, and a short one is fine when it states a rule. Lengths vary on their own when each sentence is written to say one thing.

Prefer plain verbs: use, show, start, check, need. Write "to" where "in order to" tempts. Leave out intensifiers such as `very` and `extremely`, because they weaken the claim they decorate.

Do not address the reader's feelings. Skip reassurance, enthusiasm and sales language. A reader evaluating the tool wants facts, and a reader fixing a problem wants steps.

Say a thing once, in the place it belongs, and link to it from elsewhere. Do not close a section with a paragraph that restates it. State answers directly instead of asking a question and then answering it.

## Structure by document type

### README

The README answers four things in order: what the project is, how to install it, how to use it in five minutes, and where to read more. It fits a five-minute read, and detail belongs under `docs/`. Avoid Mermaid diagrams and anything that depends on GitHub-only rendering, because the same file is shown on the extension listing.

### Reference pages

Configuration and command pages have one entry per setting or command. Each entry gives the type, default, valid range, effect and interactions with other settings. `npm run check:ref-docs` compares these pages with `package.json`, so edit both together.

### Guides

Organize guides around tasks. Write a procedure as numbered steps with one action each, and state the expected result after any step that can fail.

### Architecture decision records

Each record has a status line and a date, then context, decision and consequences. Numbers are never reused. Do not rewrite an accepted record. Add a new one that supersedes it and update the status line of the old one.

### Changelog

Use the Keep a Changelog headings (Added, Changed, Deprecated, Removed, Fixed, Security) and ISO dates. Write one line per change from the user's side: what is different for them. Record negative results and reverted experiments as plainly as successes.

### Security policy

List the supported versions, the private reporting route, what is in scope and what OCC does not protect against. Do not promise response times that nobody tracks.

### Troubleshooting

For each problem give the symptom as the user sees it, the cause, the fix and a way to confirm the fix worked. Title entries with the symptom or the exact error text.

### Evaluation reports

State the question, method, data, metrics, results with sample sizes and intervals, threats to validity and the commands that reproduce the numbers.

## Headings and layout

- Use sentence case: capitalize the first word and proper nouns only.
- Use one top-level heading per file, and do not skip levels.
- Name the content ("Index layout on disk"), not the ritual ("Overview", "Conclusion").
- Keep headings short, without a trailing colon or question mark.
- Stay within three heading levels in most pages. A page that needs more should be split.

## Lists, tables and code

- Use a numbered list for ordered steps, a bullet list for parallel items of one kind, and prose for explanation. A bullet list whose items are full paragraphs should be prose.
- Do not open every list item with a bold label. When items are label and value pairs, use a table.
- Give tables a header row, at most six columns and no empty cells. Write "none" when a value does not exist.
- Tag every code block with its language. Commands must run as written, without a leading `$` or `>`.
- Where PowerShell and bash differ, give both in separate blocks. PowerShell 5.1 does not accept `&&`, so chain commands with `;` there.
- Show expected output only when it tells the reader something, such as a count or a hash to compare against.
- Write placeholders as a name in angle brackets and say what it stands for.
- Put file paths, commands, setting keys, identifiers and error codes in code font.

## Claims and numbers

- Mark each statement as measured or designed. "The scanner runs before export" is a design fact. "Indexing took N seconds" is a measurement.
- Give a measured figure with its unit, the sample size or run count, the date or commit, and the source file. An example of the form: "Initial indexing of the 5,000-file benchmark took N seconds on the reference machine (`scripts/benchmark.ts`, run on a stated date)".
- Report estimates with intervals. When comparing two systems, say whether the interval for the difference excludes zero.
- Give timings as a range and name the machine. Do not call a change a speedup when the before and after ranges overlap.
- Name the baseline, the metric and the data set in every comparison.
- Reserve "always", "never", "guaranteed" and "100%" for properties that code or a test enforces, and name the test.
- Do not copy a number from one page to another by hand. Link to the page that owns it, or generate it.
- Report negative and inconclusive results with the same prominence as positive ones.

## Terms and naming

- Use "Offline Code Context Compiler" in full once, near the top of the README, and "OCC" afterwards.
- Define each domain term once in `docs/GLOSSARY.md` and use the same word every time. Do not alternate between "context package", "bundle" and "output" for one thing.
- Refer to a command by its palette title, and give its identifier in code font at first use.
- Refer to a setting by its full key in code font.

## Links

- Link between repository files with relative paths, and link to a heading anchor when the target is a section. `npm run check:doc-links` verifies both.
- Write link text that names the target ("the wire format specification"), never "here" or "this link".
- Add an external link only when the reader needs the source to verify a claim. Name the source and the date you read it.

## Formatting conventions

- Use ASCII punctuation in Markdown source: straight quotes, three dots for an ellipsis, commas, colons or separate sentences instead of dashes. Write number ranges with "to" or a hyphen (1-500).
- Write dates in ISO 8601 (2026-10-25). Write versions as they appear in `package.json`, and tags with the `v` prefix.
- Put a space between a number and its unit (25 ms, 1 MiB), and separate thousands with commas in prose.
- Leave no trailing spaces, one blank line between blocks, and a newline at the end of the file.
- Either wrap lines at a fixed width or do not wrap, and stay consistent within a file. Do not reflow lines you did not change.
- Do not use emoji, decorative symbols or exclamation marks.

## Review checklist

Before opening a pull request that touches documentation:

1. Run `npm run check:doc-style`, `npm run check:doc-links` and `npm run check:ref-docs`.
2. Run every command you documented, from a clean checkout where practical.
3. Trace each number to its source file and confirm it still matches.
4. Read the page once as a new user who has not seen the code, and once as a skeptical reviewer looking for claims without evidence.
5. Delete sentences that repeat another sentence or a nearby page.
6. Confirm that anything experimental, off by default or planned is labelled that way wherever it appears.
7. Confirm that no example contains a complete secret-looking value. Build such fixtures from fragments.

## Words and patterns to avoid

The gate rejects these patterns. They are listed here for reference, so the section is excluded from the check.

<!-- doc-style-ignore-start -->

Promotional words: seamless, robust, powerful, comprehensive, elegant, innovative, groundbreaking, cutting-edge, state-of-the-art, best-in-class, world-class, industry-leading, enterprise-grade, battle-tested, effortless, blazing, lightning-fast, turnkey, holistic, transformative, unparalleled, stunning, amazing, awesome, incredible.

Inflated verbs: leverage, utilize, unlock, empower, streamline, supercharge, delve, embark, facilitate, harness, elevate, foster.

Stock phrases: "it is worth noting", "it should be noted", "needless to say", "in today's", "in the world of", "at its core", "when it comes to", "plays a crucial role", "a testament to", "dive into", "whether you are", "look no further", "feel free to", "please note".

Constructions: "not just X, but Y"; "it is not A, it is B"; a question that the next sentence answers; a paragraph that opens with "In summary" or "Overall"; a list in which every item opens with a bold label; four sentences in a row that start with the same word.

Hedge stacks: "may potentially", "could possibly".

Typography: em dashes, spaced en dashes, curly quotes, the single-character ellipsis, emoji, exclamation marks, non-breaking and zero-width characters.

### Rewrite examples

| Weak | Better |
|---|---|
| OCC seamlessly leverages a robust indexing engine to deliver comprehensive context. | OCC indexes the workspace on disk and selects files for a task, up to a token limit you set. |
| Security is our top priority. | Files that match sensitive path rules are never read. Content that matches a secret pattern is redacted, and a final scan fails the build if anything still matches. |
| Our benchmark shows OCC outperforms BM25. | On the held-out tasks, OCC ranks the first relevant file higher than BM25 (paired top-1 difference with its interval, source file named). Package recall is not significantly different. |
| It is worth noting that the cache can potentially become stale. | The cache is stale after <event> until <condition>. Run <command> to rebuild it. |
| This is not just a search tool, but a complete context platform. | OCC builds a context package for a task. It does not edit code or call a model. |
| We ensure a smooth experience for all users. | The smoke test installs the packaged file into a clean profile and indexes the demo project on Linux, macOS and Windows. |
| In summary, OCC is a great option for developers. | Delete the sentence and end the section on its last fact. |
| Why does determinism matter? Because outputs can be diffed. | The same repository state and settings produce byte-identical output, so two runs can be compared with a plain diff. |

<!-- doc-style-ignore-end -->

## Running the style check

`npm run check:doc-style` reads the README, the changelog, `docs/` and `.github/`, skips generated results under `docs/eval/` and `docs/examples/`, and prints each finding with its file, line and rule. Errors fail the run. Warnings print but pass unless you add `--strict`.

```
npm run check:doc-style
npm run check:doc-style -- --strict
npm run check:doc-style -- --fix
npm run check:doc-style -- docs/ARCHITECTURE.md
```

`--fix` applies only mechanical changes: curly quotes and the ellipsis character become ASCII, and non-breaking or zero-width characters are removed. Text inside code is never touched. Everything else needs a rewrite by hand, because a dash or an inflated word usually points to a sentence that should be restructured.

The check cannot judge whether a sentence is true or useful. A clean run means the common tells are absent. The review checklist above still applies.

To keep a legitimate exception, mark it and explain it in the commit message:

```
<!-- doc-style-ignore-start -->
Text that the check skips.
<!-- doc-style-ignore-end -->

A single line that the check skips. <!-- doc-style-ignore -->
```
