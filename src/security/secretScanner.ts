/**
 * Pattern + heuristic secret detection. Best-effort by design (documented in
 * SECURITY.md and LIMITATIONS.md): high-confidence patterns block, entropy
 * heuristics catch generic credential-like values. Fixtures use fake values.
 */
import { compareStrings } from "../shared/text";

export type SecretKind =
  | "aws-access-key"
  | "private-key-block"
  | "github-token"
  | "slack-token"
  | "google-api-key"
  | "stripe-live-key"
  | "openai-style-key"
  | "jwt"
  | "bearer-token"
  | "basic-auth-url"
  | "generic-credential"
  | "env-credential";

export interface SecretFinding {
  kind: SecretKind;
  filePath: string;
  line: number;
  /** The raw matched text. NEVER logged, NEVER emitted; kept only transiently for redaction. */
  match: string;
  /** Short human-safe description for reports. */
  description: string;
  confidence: "high" | "medium";
}

interface PatternDef {
  kind: SecretKind;
  regex: RegExp;
  description: string;
  confidence: "high" | "medium";
  /** Validates the match further (reduces false positives). */
  validate?: (match: string) => boolean;
}

const PATTERNS: PatternDef[] = [
  {
    kind: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    description: "AWS access key id",
    confidence: "high",
  },
  {
    kind: "private-key-block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g,
    description: "private key block header",
    confidence: "high",
  },
  {
    kind: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    description: "GitHub token",
    confidence: "high",
  },
  {
    kind: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    description: "Slack token",
    confidence: "high",
  },
  {
    kind: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35,}\b/g,
    description: "Google API key",
    confidence: "high",
  },
  {
    kind: "stripe-live-key",
    regex: /\b(?:sk|pk)_live_[A-Za-z0-9]{16,}\b/g,
    description: "Stripe live key",
    confidence: "high",
  },
  {
    kind: "openai-style-key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    description: "OpenAI-style API key",
    confidence: "high",
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: "JWT token",
    confidence: "high",
  },
  {
    kind: "basic-auth-url",
    regex:
      /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|ftp):\/\/[^\s/:@]+:[^\s/:@]{6,}@[^\s/"']*/g,
    description: "URL embedding credentials",
    confidence: "high",
  },
  {
    kind: "bearer-token",
    regex: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{24,}/g,
    description: "bearer token in source",
    confidence: "medium",
  },
];

/** Keys whose values look like credentials when assigned long/high-entropy strings. */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`]([^"'`\n]{12,})["'`]/gi;
const ENV_ASSIGNMENT_RE =
  /^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|APIKEY)[A-Z0-9_]*)\s*[:=]\s*(\S{8,})\s*$/gm;

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface SecretScanOptions {
  /** Minimum entropy for generic credential values (bits/char). */
  entropyThreshold?: number;
}

const DEFAULT_ENTROPY_THRESHOLD = 3.3;

export interface SecretSpan {
  start: number;
  end: number;
}

export class SecretScanner {
  constructor(private readonly options: SecretScanOptions = {}) {}

  private scanMatches(content: string): Array<{
    kind: SecretKind;
    start: number;
    end: number;
    match: string;
    description: string;
    confidence: "high" | "medium";
  }> {
    const matches: Array<{
      kind: SecretKind;
      start: number;
      end: number;
      match: string;
      description: string;
      confidence: "high" | "medium";
    }> = [];
    const threshold = this.options.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;

    for (const def of PATTERNS) {
      for (const match of content.matchAll(def.regex)) {
        const text = match[0];
        if (def.validate && !def.validate(text)) continue;
        const start = match.index ?? 0;
        let end = start + text.length;
        // F01: a private-key finding must cover the KEY BODY, not just the
        // header line — under WARN/redaction a header-only match would blank
        // the header while leaving the key material exposed.
        if (def.kind === "private-key-block") {
          const endMarker = content.indexOf("-----END", end);
          if (endMarker >= 0) {
            const lineEnd = content.indexOf("\n", endMarker);
            end = lineEnd >= 0 ? lineEnd + 1 : content.length;
          } else {
            end = content.length;
          }
        }
        matches.push({
          kind: def.kind,
          start,
          end,
          match: content.slice(start, end),
          description: def.description,
          confidence: def.confidence,
        });
      }
    }

    for (const match of content.matchAll(ASSIGNMENT_RE)) {
      const value = match[2];
      if (isLikelyPlaceholder(value)) continue;
      if (shannonEntropy(value) >= threshold) {
        const start = match.index ?? 0;
        matches.push({
          kind: "generic-credential",
          start,
          end: start + match[0].length,
          match: match[0],
          description: `high-entropy value assigned to "${match[1]}"`,
          confidence: "medium",
        });
      }
    }

    for (const match of content.matchAll(ENV_ASSIGNMENT_RE)) {
      const value = match[2];
      if (isLikelyPlaceholder(value)) continue;
      if (shannonEntropy(value) >= threshold) {
        const start = match.index ?? 0;
        matches.push({
          kind: "env-credential",
          start,
          end: start + match[0].length,
          match: match[0],
          description: `env-style credential "${match[1]}"`,
          confidence: "high",
        });
      }
    }

    return matches;
  }

  /** Scans one file's content; returns findings with line numbers. */
  scan(filePath: string, content: string): SecretFinding[] {
    const findings: SecretFinding[] = this.scanMatches(content).map((m) => ({
      kind: m.kind,
      filePath,
      line: lineOfIndex(content, m.start),
      match: m.match,
      description: m.description,
      confidence: m.confidence,
    }));
    return findings.sort((a, b) => a.line - b.line || compareStrings(a.kind, b.kind));
  }

  /**
   * Stage 2 correction A: scan with EXACT character offsets, so redaction can
   * apply the union of overlapping flagged ranges against the original
   * immutable snapshot in one pass (sequential whole-match replacement breaks
   * when one redaction removes a substring another finding's match needs, and
   * it shifts line numbering).
   */
  scanDetailed(
    filePath: string,
    content: string,
  ): Array<SecretFinding & { start: number; end: number }> {
    const findings: Array<SecretFinding & { start: number; end: number }> = this.scanMatches(
      content,
    ).map((m) => ({
      kind: m.kind,
      filePath,
      line: lineOfIndex(content, m.start),
      match: m.match,
      description: m.description,
      confidence: m.confidence,
      start: m.start,
      end: m.end,
    }));
    return findings.sort((a, b) => a.line - b.line || compareStrings(a.kind, b.kind));
  }

  /**
   * Scans content and returns character offset spans [start, end) of flagged matches.
   * Minimal span-returning function reusing the exact same scanner rules and patterns.
   */
  scanSpans(content: string): SecretSpan[] {
    return this.scanMatches(content)
      .map((m) => ({ start: m.start, end: m.end }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /**
   * F02: scans a unified diff by its LOGICAL content. Line-anchored patterns
   * (env-credential assignments) only match when lines are scanned without
   * their `+`/`-` prefix — scanning the raw diff text misses everything
   * behind a prefix. Hunk headers, file headers, and index lines are
   * skipped; line numbers refer to the diff text itself. `match` values are
   * the flagged text as it appears in the diff, so callers can redact or
   * verify against the rendered payload.
   *
   * Each hunk is reconstructed as its TWO real versions and scanned
   * separately: the OLD version from removed + unchanged context lines, the
   * NEW version from added + unchanged context lines. A multiline block that
   * straddles changed and unchanged lines (e.g. a key body added inside an
   * existing key block, or a removed body between context markers) is
   * therefore ONE finding covering the whole block in that version — per-run
   * scanning reduced such blocks to header-only matches whose redaction left
   * the key body exposed. Versions never merge across hunk or file
   * boundaries, so unrelated content is never joined into fabricated blocks.
   *
   * Findings map back to the EXACT original offsets in `diffText` (LF and
   * CRLF: line starts and separator lengths are tokenized from the real
   * string, not assumed), prefixes included, and carry the caller-provided
   * section filePath so redaction and the final leak gate operate on the
   * real exported bytes. A block appearing in both versions (context-only)
   * is deduplicated to one finding.
   */
  scanDiff(diffText: string, filePath = ""): SecretFinding[] {
    interface DiffLine {
      text: string; // content without its separator
      start: number; // exact offset of the first character in diffText
    }
    // Tokenize with REAL separator widths (LF and CRLF), so reconstructed
    // match offsets are exact in the original string.
    const lines: DiffLine[] = [];
    {
      let pos = 0;
      while (pos < diffText.length) {
        const nl = diffText.indexOf("\n", pos);
        if (nl === -1) {
          lines.push({ text: diffText.slice(pos), start: pos });
          break;
        }
        const contentEnd = nl > pos && diffText[nl - 1] === "\r" ? nl - 1 : nl;
        lines.push({ text: diffText.slice(pos, contentEnd), start: pos });
        pos = nl + 1;
      }
    }

    const isHeader = (line: string): boolean =>
      /^diff --git /.test(line) ||
      /^index /i.test(line) ||
      /^@@ /.test(line) ||
      /^--- (?:a\/|b\/|\/dev\/)/.test(line) ||
      /^\+\+\+ (?:a\/|b\/|\/dev\/)/.test(line);
    const kindOf = (line: string): "added" | "removed" | "context" | "other" =>
      line.startsWith("+")
        ? "added"
        : line.startsWith("-")
          ? "removed"
          : line.startsWith(" ")
            ? "context"
            : "other";

    const findings: SecretFinding[] = [];
    const seen = new Set<string>();

    // Scan one hunk's version: lines of the given kinds joined logically.
    const scanVersion = (hunk: number[], kinds: Set<string>): void => {
      let text = "";
      const map: Array<{ diffIdx: number; start: number; end: number }> = [];
      for (const idx of hunk) {
        const line = lines[idx]!;
        const kind = kindOf(line.text);
        if (!kinds.has(kind)) continue;
        const stripped = kind === "other" ? line.text : line.text.slice(1);
        const start = text.length;
        text += stripped + "\n";
        map.push({ diffIdx: idx, start, end: text.length });
      }
      if (text.trim().length === 0) return;
      for (const m of this.scanMatches(text)) {
        const first = map.find((s) => m.start >= s.start && m.start < s.end) ?? map[0]!;
        const last = map.find((s) => m.end > s.start && m.end <= s.end) ?? map[map.length - 1]!;
        // Exact raw substring: whole first line through whole last line in
        // the ORIGINAL text (prefixes included, separators untouched).
        const rawStart = lines[first.diffIdx]!.start;
        const rawEnd = lines[last.diffIdx]!.start + lines[last.diffIdx]!.text.length;
        const key = `${m.kind}:${rawStart}:${rawEnd}`;
        if (seen.has(key)) continue; // context blocks appear in BOTH versions
        seen.add(key);
        findings.push({
          kind: m.kind,
          filePath,
          line: first.diffIdx + 1,
          match: diffText.slice(rawStart, rawEnd),
          description: m.description,
          confidence: m.confidence,
        });
      }
    };

    // Group content lines into hunks (@@-to-@@ / file-header boundaries).
    let hunk: number[] = [];
    const flushHunk = (): void => {
      if (hunk.length === 0) return;
      scanVersion(hunk, new Set(["removed", "context"])); // OLD version
      scanVersion(hunk, new Set(["added", "context"])); // NEW version
      hunk = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isHeader(line.text)) {
        flushHunk();
        continue;
      }
      hunk.push(i);
    }
    flushHunk();

    return findings.sort((a, b) => a.line - b.line || compareStrings(a.kind, b.kind));
  }
}

/**
 * Blanks identified spans in content by replacing matched characters with spaces.
 * Preserves newlines and overall character count/offsets.
 */
export function blankSpans(content: string, spans: readonly SecretSpan[]): string {
  if (spans.length === 0) return content;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  let result = "";
  let lastIndex = 0;
  for (const span of sorted) {
    if (span.end <= lastIndex) continue;
    const start = Math.max(0, Math.max(span.start, lastIndex));
    if (start > lastIndex) {
      result += content.slice(lastIndex, start);
    }
    const end = Math.min(content.length, span.end);
    let blanked = "";
    for (let i = start; i < end; i++) {
      const ch = content[i];
      blanked += ch === "\n" || ch === "\r" ? ch : " ";
    }
    result += blanked;
    lastIndex = end;
  }
  if (lastIndex < content.length) {
    result += content.slice(lastIndex);
  }
  return result;
}

const PLACEHOLDER_WORDS = [
  "changeme",
  "change_me",
  "xxx",
  "todo",
  "fixme",
  "example",
  "sample",
  "dummy",
  "fake",
  "placeholder",
  "your_api_key",
  "your-api-key",
  "insert",
  "replace",
  "redacted",
  "test",
  "abcd1234",
  "123456",
  "password123",
  "secret",
  "database",
  "localhost",
  "postgres",
  "mysql",
  "user",
  "admin",
  "root",
];

/** True for obviously non-secret placeholder strings (keeps fixtures/tests sane). */
export function isLikelyPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((w) => lower.includes(w))) return true;
  if (/^(?:\$\{|\{\{|%[A-Z_]+%|<)/.test(value)) return true; // ${VAR}, {{tpl}}, %VAR%, <...>
  if (/^x+$|^0+$|^-+$|^_+$/.test(value)) return true;
  return false;
}

function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}
