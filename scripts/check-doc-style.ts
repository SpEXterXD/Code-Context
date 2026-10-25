/**
 * Verifies that documentation files adhere to style guidelines:
 * - No banned vocabulary (seamless, robust, powerful, etc.)
 * - No em dashes (—)
 * - No exclamation marks (!) in prose
 * - No emoji
 * Code blocks, inline code, image syntax, and CHANGELOG quotes are excluded.
 * Run: npx tsx scripts/check-doc-style.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

interface StyleViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly snippet: string;
}

const violations: StyleViolation[] = [];

const BANNED_WORDS = [
  "seamless",
  "robust",
  "powerful",
  "leverage",
  "comprehensive",
  "cutting-edge",
  "state-of-the-art",
  "game-changing",
  "revolutionary",
  "effortless",
  "elegant",
  "delve",
  "unlock",
  "empower",
  "supercharge",
  "streamline",
  "holistic",
];

const BANNED_PHRASES = [
  /\bin today's\b/i,
  /\bit's worth noting\b/i,
  /\bwhether you're\b/i,
  /\bnot just\s+[\w\s]+,\s+but\b/i,
];

// Emoji unicode regex
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function findDocsFiles(): string[] {
  const files: string[] = [path.join(ROOT, "README.md")];
  if (fs.existsSync(path.join(ROOT, "SECURITY.md"))) {
    files.push(path.join(ROOT, "SECURITY.md"));
  }
  if (fs.existsSync(path.join(ROOT, "CONTRIBUTING.md"))) {
    files.push(path.join(ROOT, "CONTRIBUTING.md"));
  }

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "eval") {
          // eval results are generated evaluation run outputs
          continue;
        }
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        files.push(full);
      }
    }
  }

  walk(path.join(ROOT, "docs"));
  return files;
}

function checkFile(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Track code blocks
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    // Strip inline code `...`
    let prose = rawLine.replace(/`[^`]*`/g, " ");

    // Strip markdown images ![alt](url)
    prose = prose.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");

    // Strip link destinations [text](url) -> text
    prose = prose.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

    // 1. Check for em dash (U+2014)
    if (prose.includes("—") || prose.includes("\u2014")) {
      violations.push({
        file: path.relative(ROOT, filePath),
        line: i + 1,
        reason: "Em dash (—) is banned; use commas, colons, parentheses, or separate sentences",
        snippet: rawLine.trim(),
      });
    }

    // 2. Check for exclamation marks
    if (prose.includes("!")) {
      violations.push({
        file: path.relative(ROOT, filePath),
        line: i + 1,
        reason: "Exclamation marks (!) are banned in prose",
        snippet: rawLine.trim(),
      });
    }

    // 3. Check for emoji
    if (EMOJI_REGEX.test(prose)) {
      violations.push({
        file: path.relative(ROOT, filePath),
        line: i + 1,
        reason: "Emoji are banned in prose",
        snippet: rawLine.trim(),
      });
    }

    // 4. Check for banned words
    for (const word of BANNED_WORDS) {
      const wordRegex = new RegExp(`\\b${word}\\b`, "i");
      if (wordRegex.test(prose)) {
        violations.push({
          file: path.relative(ROOT, filePath),
          line: i + 1,
          reason: `Banned vocabulary '${word}'`,
          snippet: rawLine.trim(),
        });
      }
    }

    // 5. Check for banned phrases
    for (const phrase of BANNED_PHRASES) {
      if (phrase.test(prose)) {
        violations.push({
          file: path.relative(ROOT, filePath),
          line: i + 1,
          reason: `Banned phrase '${phrase.source}'`,
          snippet: rawLine.trim(),
        });
      }
    }
  }
}

function main(): void {
  const files = findDocsFiles();
  for (const file of files) {
    checkFile(file);
  }

  if (violations.length > 0) {
    console.error(`FAIL: Found ${violations.length} documentation style violation(s):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} -> ${v.reason}\n    "${v.snippet}"`);
    }
    process.exit(1);
  }

  console.log(`ok: checked ${files.length} doc files; all style rules pass`);
}

main();
