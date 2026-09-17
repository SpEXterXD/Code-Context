/**
 * Pattern + heuristic secret detection. Best-effort by design (documented in
 * SECURITY.md and LIMITATIONS.md): high-confidence patterns block, entropy
 * heuristics catch generic credential-like values. Fixtures use fake values.
 */

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

export class SecretScanner {
  constructor(private readonly options: SecretScanOptions = {}) {}

  /** Scans one file's content; returns findings with line numbers. */
  scan(filePath: string, content: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const threshold = this.options.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;

    for (const def of PATTERNS) {
      for (const match of content.matchAll(def.regex)) {
        const text = match[0];
        if (def.validate && !def.validate(text)) continue;
        findings.push({
          kind: def.kind,
          filePath,
          line: lineOfIndex(content, match.index ?? 0),
          match: text,
          description: def.description,
          confidence: def.confidence,
        });
      }
    }

    for (const match of content.matchAll(ASSIGNMENT_RE)) {
      const value = match[2];
      if (isLikelyPlaceholder(value)) continue;
      if (shannonEntropy(value) >= threshold) {
        findings.push({
          kind: "generic-credential",
          filePath,
          line: lineOfIndex(content, match.index ?? 0),
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
        findings.push({
          kind: "env-credential",
          filePath,
          line: lineOfIndex(content, match.index ?? 0),
          match: match[0],
          description: `env-style credential "${match[1]}"`,
          confidence: "high",
        });
      }
    }

    return findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  }
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
