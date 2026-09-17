import { compareStrings } from "../shared/text";

/**
 * Path-based sensitivity rules (defense in depth on top of exclude patterns):
 * files matching these rules are flagged even if they somehow get indexed.
 */
const SENSITIVE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /(^|\/)\.env($|\.)/i, reason: "environment file" },
  { regex: /\.(pem|key|p12|pfx|jks|keystore)$/i, reason: "key material" },
  { regex: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.[^.]+$)/, reason: "SSH private key" },
  { regex: /(^|\/)(credentials|secrets?)(\.[^/]+)?$/i, reason: "credential store" },
  { regex: /(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)\.netrc$/, reason: "registry credentials file" },
  { regex: /(^|\/)secrets?\.(ya?ml|json)$/i, reason: "secrets file" },
  { regex: /(^|\/)\.git-credentials$/, reason: "git credential store" },
];

export interface SensitivePathFinding {
  filePath: string;
  reason: string;
}

export function sensitivePathCheck(filePath: string): SensitivePathFinding | null {
  for (const { regex, reason } of SENSITIVE_PATTERNS) {
    if (regex.test(filePath)) return { filePath, reason };
  }
  return null;
}

export function sensitivePathChecks(paths: string[]): SensitivePathFinding[] {
  return paths
    .map(sensitivePathCheck)
    .filter((f): f is SensitivePathFinding => f !== null)
    .sort((a, b) => compareStrings(a.filePath, b.filePath));
}
