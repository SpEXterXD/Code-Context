/**
 * M4: stack-trace / error-text parsing as a pure function. Linear-time
 * anchored patterns only (no nested quantifiers, no backtracking blowups);
 * input is hard-capped at 64 KB before parsing; match output is capped.
 * Returns RAW candidate paths in first-seen order — resolution against the
 * workspace index happens in the retrieval layer, so paths outside the
 * workspace can never escape (only indexed paths survive resolution).
 */

export const STACK_TRACE_MAX_INPUT_CHARS = 64 * 1024;
export const STACK_TRACE_MAX_MATCHES = 50;

// One generic matcher covers Node/TS/Go frames and plain "file:line:col"
// mentions: a path-ish token ending in an extension, followed by :line and
// optional :col. Anchored on non-space runs; strictly linear.
const FILE_LINE_COL_RE =
  /(?:^|[\s([])((?:[A-Za-z]:)?[^\s()[\]{}:'"`,]+?\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/g;
// Java: "at pkg.Class.method(pkg/File.java:12)" — capture the source file.
const JAVA_FRAME_RE = /\(([\w$./-]+\.java):(\d+)\)/g;
// Python: 'File "path", line 12'.
const PYTHON_FRAME_RE = /File "([^"\n]+)", line (\d+)/g;

export interface StackFrame {
  /** Raw path as it appeared in the trace (may be absolute or relative). */
  path: string;
  line: number;
  /** Source format that produced the frame. */
  source: "file-line-col" | "java" | "python";
}

function isPlausiblePath(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false;
  if (/^node:/i.test(p) || /^(?:https?|ext|data):/i.test(p)) return false;
  if (p.startsWith("<")) return false; // <anonymous>, <internal>
  return true;
}

/** Parses up to MAX_MATCHES frames; never throws; caps input at 64 KB. */
export function parseStackTrace(input: string): StackFrame[] {
  const text =
    input.length > STACK_TRACE_MAX_INPUT_CHARS
      ? input.slice(0, STACK_TRACE_MAX_INPUT_CHARS)
      : input;
  const out: StackFrame[] = [];
  const seen = new Set<string>();
  const push = (path: string, line: number, source: StackFrame["source"]): boolean => {
    if (out.length >= STACK_TRACE_MAX_MATCHES) return false;
    const key = `${path}:${line}`;
    if (!isPlausiblePath(path) || seen.has(key)) return true;
    seen.add(key);
    out.push({ path, line, source });
    return true;
  };

  // Java and Python patterns first (more specific); then the generic
  // file:line:col scan for everything else (Node/TS/Go/plain text).
  for (const m of text.matchAll(JAVA_FRAME_RE)) {
    if (!push(m[1]!, parseInt(m[2]!, 10) || 0, "java")) return out;
  }
  for (const m of text.matchAll(PYTHON_FRAME_RE)) {
    if (!push(m[1]!, parseInt(m[2]!, 10) || 0, "python")) return out;
  }
  for (const m of text.matchAll(FILE_LINE_COL_RE)) {
    if (!push(m[1]!, parseInt(m[2]!, 10) || 0, "file-line-col")) return out;
  }
  return out;
}
