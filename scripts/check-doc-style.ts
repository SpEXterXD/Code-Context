/**
 * Documentation style gate.
 *
 * Flags writing patterns that read as machine-generated, promotional or
 * padded, and checks a few structural habits (heading case, skipped levels,
 * uniform sentence rhythm). It reads Markdown only and needs no dependencies.
 *
 * Usage:
 *   npx tsx scripts/check-doc-style.ts                  check the default file set
 *   npx tsx scripts/check-doc-style.ts docs/A.md        check only the given files
 *   npx tsx scripts/check-doc-style.ts --strict         warnings also fail the run
 *   npx tsx scripts/check-doc-style.ts --fix            apply mechanical fixes, then check
 *   npx tsx scripts/check-doc-style.ts --json           print the result as JSON
 *
 * Exit codes: 0 clean, 1 findings fail the run, 2 usage error.
 *
 * Suppression (use sparingly, and say why in the commit message):
 *   <!-- doc-style-ignore -->                           at the end of a line
 *   <!-- doc-style-ignore-start --> ... <!-- doc-style-ignore-end -->
 *
 * What it does not do: it cannot judge whether a sentence is true or useful.
 * A clean run means the common tells are absent, not that the text is good.
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Severity = "error" | "warn" | "note";

interface Finding {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: Severity;
  message: string;
  excerpt: string;
}

interface LineRule {
  id: string;
  severity: Severity;
  re: RegExp;
  message: string;
}

interface Prepared {
  raw: string[];
  /** Same line count and line lengths as raw, with code, links and comments blanked. */
  prose: string[];
  ignored: boolean[];
  eol: string;
}

interface Paragraph {
  startLine: number;
  text: string;
}

const ROOT = process.cwd();
const ROOT_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "RELEASE_NOTES.md",
];
const ROOT_DIRS = ["docs", ".github"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".eval-cache", ".vscode-test"]);
// Generated output is not prose written by hand.
const SKIP_PATHS = [/^docs\/eval\/results[^/]*\.md$/, /^docs\/examples\//];

const MAX_SENTENCE_WORDS = 45;
const MAX_PARAGRAPH_WORDS = 140;
const MIN_SENTENCES_FOR_RHYTHM = 25;
const MIN_RHYTHM_VARIATION = 0.4;

function wordRule(id: string, severity: Severity, parts: string[], message: string): LineRule {
  return { id, severity, re: new RegExp(`\\b(?:${parts.join("|")})\\b`, "gi"), message };
}

// Promotional, inflated or stock vocabulary. Each entry is a regex fragment.
const SLOP_WORDS = [
  "seamless(?:ly)?",
  "robust(?:ness)?",
  "powerful(?:ly)?",
  "leverag(?:e|es|ed|ing)",
  "comprehensive(?:ly)?",
  "cutting[- ]edge",
  "state[- ]of[- ]the[- ]art",
  "game[- ]chang(?:er|ers|ing)",
  "revolution(?:ary|ize|izes|ized|izing)",
  "effortless(?:ly)?",
  "elegant(?:ly)?",
  "delv(?:e|es|ed|ing)",
  "unlock(?:s|ed|ing)?",
  "empower(?:s|ed|ing|ment)?",
  "supercharg(?:e|es|ed|ing)",
  "turbocharg(?:e|es|ed|ing)",
  "streamlin(?:e|es|ed|ing)",
  "holistic(?:ally)?",
  "best[- ]in[- ]class",
  "world[- ]class",
  "industry[- ]leading",
  "enterprise[- ]grade",
  "battle[- ]tested",
  "military[- ]grade",
  "next[- ]gen(?:eration)?",
  "blazing(?:ly)?",
  "lightning[- ]fast",
  "synerg(?:y|ies|istic)",
  "tapestry",
  "realm",
  "myriad",
  "plethora",
  "multifaceted",
  "meticulous(?:ly)?",
  "endeavou?rs?",
  "embark(?:s|ed|ing)?",
  "utili[sz](?:e|es|ed|ing)",
  "innovative",
  "groundbreaking",
  "transformative",
  "unparalleled",
  "unmatched",
  "stunning(?:ly)?",
  "amazing(?:ly)?",
  "awesome",
  "incredibl[ey]",
  "exciting",
  "delightful(?:ly)?",
  "sleek",
  "turnkey",
  "paradigm",
];

// Words that are sometimes fine but often pad a sentence or hide a missing fact.
const WEAK_WORDS = [
  "very",
  "really",
  "quite",
  "extremely",
  "highly",
  "basically",
  "essentially",
  "actually",
  "literally",
  "simply",
  "easily",
  "obviously",
  "importantly",
  "crucial(?:ly)?",
  "vital(?:ly)?",
  "pivotal",
  "various",
  "numerous",
  "nuanced",
  "landscape",
  "ecosystem",
  "facilitat(?:e|es|ed|ing)",
  "intricate",
  "bespoke",
  "elevat(?:e|es|ed|ing)",
  "foster(?:s|ed|ing)?",
  "harness(?:es|ed|ing)?",
  "journey",
  "intuitive",
  "user[- ]friendly",
  "production[- ]ready",
  "mission[- ]critical",
  "ultimate(?:ly)?",
  "perfect(?:ly)?",
  "beautiful(?:ly)?",
  "passionate",
  "crafted",
  "tailored",
  "curated",
  "gold standard",
  "out[- ]of[- ]the[- ]box",
  "under the hood",
  "best practices?",
  "first[- ]class",
  "single source of truth",
  "deep dive",
];

const FILLER_PHRASES = [
  "it['\u2019]s worth (?:noting|mentioning|pointing out)",
  "it is (?:important|worth) to (?:note|mention|remember)",
  "it should be noted",
  "needless to say",
  "in today['\u2019]s",
  "in the (?:world|realm|landscape|era) of",
  "whether you['\u2019]re",
  "whether you are",
  "look no further",
  "say goodbye to",
  "(?:to|on) the next level",
  "plays? an? (?:crucial|key|vital|pivotal|significant|important) role",
  "a testament to",
  "dive (?:deep )?into",
  "here['\u2019]s the thing",
  "(?:i|we) hope this helps",
  "as an ai",
  "don['\u2019]t hesitate to",
  "(?:can|may|might|could) (?:potentially|possibly)",
  "you['\u2019]ll (?:love|be amazed|be surprised)",
];

const SOFT_PHRASES = [
  "when it comes to",
  "at its core",
  "please note",
  "note that",
  "feel free to",
  "an? (?:wide|broad|diverse) (?:range|variety|array) of",
  "in (?:conclusion|summary)",
  "serves? as",
  "stands? as",
  "boasts?",
];

const LINE_RULES: LineRule[] = [
  {
    id: "em-dash",
    severity: "error",
    re: /\u2014/g,
    message: "Em dash. Use a comma, a colon, parentheses or a new sentence.",
  },
  {
    id: "spaced-en-dash",
    severity: "error",
    re: / \u2013 /g,
    message: "Spaced en dash used as a dash. Rewrite the sentence.",
  },
  {
    id: "double-hyphen-dash",
    severity: "error",
    re: /\s--\s/g,
    message: "Double hyphen used as a dash. Rewrite the sentence.",
  },
  {
    id: "exclamation",
    severity: "error",
    re: /!(?=\s|$)/g,
    message: "Exclamation mark in prose.",
  },
  {
    id: "emoji",
    severity: "error",
    re: /(?![\u00A9\u00AE\u2122\u2194-\u21AA])\p{Extended_Pictographic}|[\u2713\u2714]/gu,
    message: "Emoji or decorative symbol.",
  },
  {
    id: "hidden-char",
    severity: "error",
    re: /[\u00A0\u200B\u200C\u200D\u2060\uFEFF]/g,
    message: "Non-breaking space or zero-width character (fixable with --fix).",
  },
  {
    id: "curly-punctuation",
    severity: "warn",
    re: /[\u2018\u2019\u201C\u201D\u2026]/g,
    message: "Typographic quote or ellipsis. Use ASCII punctuation (fixable with --fix).",
  },
  {
    id: "rhetorical-question",
    severity: "warn",
    re: /\?(?=\s|$)/g,
    message: "Question in prose. State the answer directly.",
  },
  {
    id: "fragment-question",
    severity: "error",
    re: /\b(?:the|a) (?:result|catch|upshot|bottom line|takeaway)\?/gi,
    message: "Stock fragment question. State the point.",
  },
  {
    id: "not-just-but",
    severity: "error",
    re: /\bnot (?:just|only|merely|simply)\b[^.!?\n]{1,90}?\bbut\b/gi,
    message: "'Not just X, but Y' construction. State Y.",
  },
  {
    id: "negation-pivot",
    severity: "warn",
    re: /\b(?:isn['\u2019]t|is not|it['\u2019]s not|aren['\u2019]t|are not)\b[^.!?\n]{1,60}[,;]\s*(?:it['\u2019]s|it is|they['\u2019]re|they are)\b/gi,
    message: "Negate-then-correct pattern ('X is not A, it is B'). State B.",
  },
  wordRule(
    "slop-word",
    "error",
    SLOP_WORDS,
    "Promotional or inflated word. Say the specific thing.",
  ),
  wordRule("filler-phrase", "error", FILLER_PHRASES, "Stock phrase. Say the specific thing."),
  wordRule("weak-word", "warn", WEAK_WORDS, "Vague or padding word. Delete it or be specific."),
  wordRule(
    "soft-phrase",
    "warn",
    SOFT_PHRASES,
    "Stock phrase. Check whether the sentence needs it.",
  ),
];

const RECAP_OPENER =
  /^(?:in summary|in conclusion|to summarize|to sum up|overall|ultimately|in essence|together,)\b/i;
const VAGUE_HEADING =
  /^(?:conclusion|final thoughts|key takeaways|summary|in summary|wrapping up|closing thoughts)$/i;
const FIXABLE = /[\u2018\u2019\u201C\u201D\u2026\u00A0\u200B\u200C\u200D\u2060\uFEFF]/g;

function replacementFor(ch: string): string {
  switch (ch) {
    case "\u2018":
    case "\u2019":
      return "'";
    case "\u201C":
    case "\u201D":
      return '"';
    case "\u2026":
      return "...";
    case "\u00A0":
      return " ";
    default:
      return "";
  }
}

function blank(text: string): string {
  return " ".repeat(text.length);
}

function prepare(text: string): Prepared {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const raw = text.split(/\r?\n/);
  const prose: string[] = [];
  const ignored: boolean[] = [];
  let fence: string | null = null;
  let blockIgnore = false;

  for (const line of raw) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      prose.push(blank(line));
      ignored.push(true);
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      const marker = closing ? closing[1] : undefined;
      if (
        marker !== undefined &&
        marker.startsWith(fence.charAt(0)) &&
        marker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (opening && opening[1] !== undefined) {
      fence = opening[1];
      prose.push(blank(line));
      ignored.push(true);
      continue;
    }

    const withoutInlineCode = line.replace(/`[^`]*`/g, "");
    if (/<!--\s*doc-style-ignore-start\s*-->/.test(withoutInlineCode)) {
      blockIgnore = true;
    }
    const lineIgnored = blockIgnore || /<!--\s*doc-style-ignore\s*-->/.test(withoutInlineCode);
    if (/<!--\s*doc-style-ignore-end\s*-->/.test(withoutInlineCode)) {
      blockIgnore = false;
    }

    let p = line;
    p = p.replace(/<!--.*?-->/g, blank);
    p = p.replace(/`[^`]*`/g, blank);
    p = p.replace(/\]\([^)]*\)/g, (m) => "]" + blank(m.slice(1)));
    p = p.replace(/https?:\/\/[^\s)>\]]+/g, blank);
    p = p.replace(/<\/?[a-zA-Z][^>]*>/g, blank);
    if (/^\s*\[[^\]]+\]:\s+\S+/.test(line)) {
      p = blank(line);
    }
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")) {
      p = blank(line);
    }
    prose.push(p);
    ignored.push(lineIgnored);
  }
  return { raw, prose, ignored, eol };
}

function paragraphsOf(prep: Prepared): Paragraph[] {
  const out: Paragraph[] = [];
  let current: string[] = [];
  let start = 0;
  const flush = (): void => {
    if (current.length > 0) {
      out.push({ startLine: start, text: current.join(" ").replace(/\s+/g, " ").trim() });
      current = [];
    }
  };
  prep.prose.forEach((p, i) => {
    const t = p.trim();
    const skip =
      prep.ignored[i] === true ||
      t === "" ||
      /^#{1,6}\s/.test(t) ||
      t.startsWith("|") ||
      t.startsWith(">") ||
      /^[-*+]\s/.test(t) ||
      /^\d+[.)]\s/.test(t);
    if (skip) {
      flush();
      return;
    }
    if (current.length === 0) {
      start = i + 1;
    }
    current.push(t);
  });
  flush();
  return out.filter((x) => x.text.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordCount(text: string): number {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g) ?? []).length;
}

function meanAndStd(nums: number[]): { mean: number; std: number } {
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return { mean, std: Math.sqrt(variance) };
}

function looksTitleCase(text: string): boolean {
  const words = text
    .replace(/`[^`]*`/g, "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z][A-Za-z'\u2019-]*$/.test(w));
  if (words.length < 4) {
    return false;
  }
  const rest = words.slice(1).filter((w) => w.length > 3);
  if (rest.length < 3) {
    return false;
  }
  const capitalised = rest.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  return capitalised / rest.length > 0.6;
}

function checkFile(file: string, prep: Prepared): { findings: Finding[]; words: number } {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (
    line: number,
    col: number,
    rule: string,
    severity: Severity,
    message: string,
  ): void => {
    const key = `${line}:${col}:${rule}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const excerpt = (prep.raw[line - 1] ?? "").trim().slice(0, 110);
    findings.push({ file, line, col, rule, severity, message, excerpt });
  };

  // Line-level patterns.
  let words = 0;
  prep.prose.forEach((line, i) => {
    if (prep.ignored[i] === true || line.trim() === "") {
      return;
    }
    words += wordCount(line);
    for (const rule of LINE_RULES) {
      for (const m of line.matchAll(rule.re)) {
        add(i + 1, (m.index ?? 0) + 1, rule.id, rule.severity, rule.message);
      }
    }
  });

  // Headings.
  let previousLevel = 0;
  let h1Count = 0;
  prep.raw.forEach((line, i) => {
    if (prep.ignored[i] === true) {
      return;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h || h[1] === undefined || h[2] === undefined) {
      return;
    }
    const level = h[1].length;
    const text = h[2];
    if (level === 1) {
      h1Count += 1;
      if (h1Count > 1) {
        add(i + 1, 1, "multiple-h1", "warn", "More than one top-level heading in a file.");
      }
    }
    if (previousLevel > 0 && level > previousLevel + 1) {
      add(
        i + 1,
        1,
        "heading-skip",
        "warn",
        `Heading level jumps from ${previousLevel} to ${level}.`,
      );
    }
    previousLevel = level;
    if (/[:?]$/.test(text)) {
      add(i + 1, 1, "heading-punctuation", "warn", "Heading ends with a colon or question mark.");
    }
    if (level > 1 && looksTitleCase(text)) {
      add(i + 1, 1, "heading-case", "warn", "Heading looks like Title Case. Use sentence case.");
    }
    if (VAGUE_HEADING.test(text.trim())) {
      add(
        i + 1,
        1,
        "vague-heading",
        "warn",
        "Heading names a ritual section, not content. Say what the section holds.",
      );
    }
  });

  // Bold-label lists: four or more consecutive items that open with a bold label.
  let run = 0;
  let runStart = 0;
  const closeRun = (): void => {
    if (run >= 4) {
      add(
        runStart,
        1,
        "bold-label-list",
        "warn",
        `List of ${run} items that all open with a bold label. Use a table or plain items.`,
      );
    }
    run = 0;
  };
  prep.prose.forEach((p, i) => {
    if (prep.ignored[i] !== true && /^\s*(?:[-*+]|\d+[.)])\s+\*\*[^*]+\*\*/.test(p)) {
      if (run === 0) {
        runStart = i + 1;
      }
      run += 1;
    } else {
      closeRun();
    }
  });
  closeRun();

  // Paragraph-level patterns.
  const sentenceLengths: number[] = [];
  for (const para of paragraphsOf(prep)) {
    if (RECAP_OPENER.test(para.text)) {
      add(
        para.startLine,
        1,
        "recap-opener",
        "error",
        "Paragraph opens with a recap phrase. Start with the point.",
      );
    }
    if (wordCount(para.text) > MAX_PARAGRAPH_WORDS) {
      add(
        para.startLine,
        1,
        "long-paragraph",
        "warn",
        `Paragraph is longer than ${MAX_PARAGRAPH_WORDS} words. Split it.`,
      );
    }
    if ((para.text.match(/\*\*[^*]+\*\*/g) ?? []).length > 3) {
      add(
        para.startLine,
        1,
        "bold-density",
        "warn",
        "More than three bold spans in one paragraph.",
      );
    }
    const sentences = splitSentences(para.text);
    let sameOpener = 1;
    let previous = "";
    for (const s of sentences) {
      const n = wordCount(s);
      sentenceLengths.push(n);
      if (n > MAX_SENTENCE_WORDS) {
        add(para.startLine, 1, "long-sentence", "warn", `Sentence of ${n} words. Split it.`);
      }
      const opener = (s.match(/[A-Za-z][A-Za-z'-]*/)?.[0] ?? "").toLowerCase();
      sameOpener = opener !== "" && opener === previous ? sameOpener + 1 : 1;
      previous = opener;
      if (sameOpener === 4) {
        add(
          para.startLine,
          1,
          "repeated-opener",
          "warn",
          `Four sentences in a row start with "${opener}".`,
        );
      }
    }
  }

  // File-level rhythm: uniform sentence length is a common tell in generated text.
  if (sentenceLengths.length >= MIN_SENTENCES_FOR_RHYTHM) {
    const { mean, std } = meanAndStd(sentenceLengths);
    if (mean > 0 && std / mean < MIN_RHYTHM_VARIATION) {
      add(
        1,
        1,
        "uniform-rhythm",
        "note",
        `Sentence lengths are very uniform (mean ${mean.toFixed(1)}, variation ${(std / mean).toFixed(2)}). Vary the rhythm.`,
      );
    }
  }

  findings.sort((a, b) => a.line - b.line || a.col - b.col);
  return { findings, words };
}

function applyFixes(prep: Prepared): { text: string; count: number } {
  let count = 0;
  const lines = prep.raw.map((line, i) => {
    if (prep.ignored[i] === true) {
      return line;
    }
    const masked = prep.prose[i] ?? "";
    const edits: Array<{ index: number; to: string }> = [];
    for (const m of masked.matchAll(FIXABLE)) {
      edits.push({ index: m.index ?? 0, to: replacementFor(m[0]) });
    }
    let result = line;
    for (const e of edits.reverse()) {
      result = result.slice(0, e.index) + e.to + result.slice(e.index + 1);
      count += 1;
    }
    return result;
  });
  return { text: lines.join(prep.eol), count };
}

function listMarkdown(dir: string, out: string[]): void {
  const entries = (() => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) {
        listMarkdown(full, out);
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function defaultFiles(): string[] {
  const found: string[] = [];
  for (const f of ROOT_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) {
      found.push(full);
    }
  }
  for (const d of ROOT_DIRS) {
    listMarkdown(path.join(ROOT, d), found);
  }
  return found.filter((f) => !SKIP_PATHS.some((re) => re.test(relative(f)))).sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const fix = args.includes("--fix");
  const asJson = args.includes("--json");
  const explicit = args.filter((a) => !a.startsWith("--"));

  const files = explicit.length > 0 ? explicit.map((f) => path.resolve(ROOT, f)) : defaultFiles();
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error(`File not found: ${missing.map(relative).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const all: Finding[] = [];
  const summary: Array<{
    file: string;
    words: number;
    errors: number;
    warnings: number;
    notes: number;
  }> = [];
  let fixed = 0;

  for (const file of files) {
    let text = fs.readFileSync(file, "utf8");
    if (fix) {
      const result = applyFixes(prepare(text));
      if (result.count > 0 && result.text !== text) {
        fs.writeFileSync(file, result.text, "utf8");
        text = result.text;
        fixed += result.count;
      }
    }
    const { findings, words } = checkFile(relative(file), prepare(text));
    all.push(...findings);
    summary.push({
      file: relative(file),
      words,
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warn").length,
      notes: findings.filter((f) => f.severity === "note").length,
    });
  }

  const errors = all.filter((f) => f.severity === "error").length;
  const warnings = all.filter((f) => f.severity === "warn").length;
  const notes = all.filter((f) => f.severity === "note").length;

  if (asJson) {
    console.log(
      JSON.stringify({ fixed, errors, warnings, notes, summary, findings: all }, null, 2),
    );
  } else {
    for (const f of all) {
      console.log(`${f.file}:${f.line}:${f.col}  ${f.severity.padEnd(5)}  ${f.rule}  ${f.message}`);
      console.log(`    | ${f.excerpt}`);
    }
    if (all.length > 0) {
      console.log("");
    }
    console.log(
      "file".padEnd(44) +
        "words".padStart(7) +
        "errors".padStart(8) +
        "warns".padStart(7) +
        "per 1k words".padStart(14),
    );
    for (const s of summary) {
      const density = s.words > 0 ? ((s.errors + s.warnings) / s.words) * 1000 : 0;
      console.log(
        s.file.padEnd(44) +
          String(s.words).padStart(7) +
          String(s.errors).padStart(8) +
          String(s.warnings).padStart(7) +
          density.toFixed(1).padStart(14),
      );
    }
    console.log("");
    if (fix) {
      console.log(`Applied ${fixed} mechanical fix(es).`);
    }
    let countMsg = `${summary.length} file(s) checked: ${errors} error(s), ${warnings} warning(s)`;
    if (notes > 0) {
      countMsg += `, ${notes} note(s)`;
    }
    console.log(countMsg + ".");
  }

  if (errors > 0 || (strict && warnings > 0)) {
    process.exitCode = 1;
  }
}

main();
