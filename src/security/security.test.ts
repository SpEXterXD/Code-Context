import { describe, expect, it } from "vitest";

import {
  isLikelyPlaceholder,
  SecretScanner,
  shannonEntropy,
  type SecretFinding,
} from "./secretScanner";
import { redactMatch, assertSecretsAbsent } from "./redactor";
import { applySecurityPolicy, verifyNoSecretLeaks } from "./securityService";
import { sensitivePathCheck, sensitivePathChecks } from "./sensitivePathRules";
import type { FileEntry } from "../domain/model";
import { sha256Hex } from "../shared/ids";

const scanner = new SecretScanner();

describe("shannonEntropy", () => {
  it("scores low-entropy and high-entropy strings differently", () => {
    expect(shannonEntropy("aaaaaaaaaaaaaaaa")).toBe(0);
    expect(shannonEntropy("J8s2kLq9zX1pQw7vR3mN")).toBeGreaterThan(3.5);
  });
});

describe("isLikelyPlaceholder", () => {
  it("recognizes common placeholder shapes", () => {
    expect(isLikelyPlaceholder("changeme")).toBe(true);
    expect(isLikelyPlaceholder("${DATABASE_PASSWORD}")).toBe(true);
    expect(isLikelyPlaceholder("xxxxxxxx")).toBe(true);
    expect(isLikelyPlaceholder("J8s2kLq9zX1pQw7vR3mN")).toBe(false);
  });
});

describe("SecretScanner patterns", () => {
  it("finds AWS keys, private keys, github/slack/google/stripe/openai tokens and JWTs", () => {
    const content = [
      "const awsId = 'AKIAIOSFODNN7EXAMPLE';",
      "-----BEGIN RSA PRIVATE KEY-----",
      "const gh = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';",
      "const slack = 'xoxb-123456789012-abcdef';",
      "const gkey = 'AIzaSyD-1a2b3c4d5e6f7g8h9i0jK_lmnopqrstuv';",
      "const stripe = 'sk_live_a1b2c3d4e5f6g7h8';",
      "const oai = 'sk-proj-a1b2c3d4e5f6g7h8i9j0';",
      "const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6eyJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';",
    ].join("\n");
    const findings = scanner.scan("fixture.ts", content);
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds).toContain("aws-access-key");
    expect(kinds).toContain("private-key-block");
    expect(kinds).toContain("github-token");
    expect(kinds).toContain("slack-token");
    expect(kinds).toContain("google-api-key");
    expect(kinds).toContain("stripe-live-key");
    expect(kinds).toContain("openai-style-key");
    expect(kinds).toContain("jwt");
  });

  it("finds credentials in URLs and bearer headers with line numbers", () => {
    const content = [
      "const ok = 1;",
      "const dbUrl = 'postgres://admin:S3cr3tValue@db.internal:5432/app';",
      "fetch(url, { headers: { authorization: 'Bearer abc123def456ghi789jkl012' } });",
    ].join("\n");
    const findings = scanner.scan("fixture.ts", content);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("basic-auth-url");
    expect(kinds).toContain("bearer-token");
    const urlFinding = findings.find((f) => f.kind === "basic-auth-url")!;
    expect(urlFinding.line).toBe(2);
  });

  it("flags high-entropy assignments and .env-style credentials", () => {
    const code = "const apiKey = 'J8s2kLq9zX1pQw7vR3mNtYu5';";
    expect(scanner.scan("a.ts", code).map((f) => f.kind)).toContain("generic-credential");
    const env = "API_KEY=J8s2kLq9zX1pQw7vR3mNtYu5";
    expect(scanner.scan(".env", env).map((f) => f.kind)).toContain("env-credential");
  });

  it("ignores obvious placeholders and template variables", () => {
    expect(scanner.scan("a.ts", "const apiKey = process.env.API_KEY;")).toHaveLength(0);
    expect(scanner.scan("a.ts", "const apiKey = 'xxx';")).toHaveLength(0);
    expect(scanner.scan("a.ts", "const password = 'test';")).toHaveLength(0);
  });
});

describe("sensitive path rules", () => {
  it("flags env files, key material and credential stores", () => {
    expect(sensitivePathCheck(".env")?.reason).toBe("environment file");
    expect(sensitivePathCheck("config/server.pem")?.reason).toBe("key material");
    expect(sensitivePathCheck("ssh/id_rsa")?.reason).toBe("SSH private key");
    expect(sensitivePathCheck(".npmrc")?.reason).toBe("registry credentials file");
    expect(sensitivePathCheck("src/normal.ts")).toBeNull();
  });

  it("checks a list and sorts deterministically", () => {
    const findings = sensitivePathChecks(["creds/.env.local", "a.pem"]);
    expect(findings.map((f) => f.filePath)).toEqual(["a.pem", "creds/.env.local"]);
  });
});

describe("redaction", () => {
  it("replaces secrets with deterministic non-reversible tokens", () => {
    const finding: SecretFinding = {
      kind: "aws-access-key",
      filePath: "a.ts",
      line: 1,
      match: "AKIAIOSFODNN7EXAMPLE",
      description: "AWS access key id",
      confidence: "high",
    };
    const text = "id = AKIAIOSFODNN7EXAMPLE; backup = AKIAIOSFODNN7EXAMPLE;";
    const { text: redacted, replaced } = redactMatch(finding, text);
    expect(replaced).toBe(2);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toContain("[REDACTED:aws-access-key:");
    // deterministic
    expect(redactMatch(finding, text).text).toBe(redacted);
    expect(assertSecretsAbsent([finding], redacted)).toHaveLength(0);
    expect(assertSecretsAbsent([finding], text)).toHaveLength(1);
  });
});

describe("applySecurityPolicy", () => {
  function entry(path: string): FileEntry {
    return {
      meta: {
        path,
        language: "typescript",
        sizeBytes: 10,
        lineCount: 1,
        contentHash: sha256Hex(path),
        isTest: false,
        parseStatus: "PARSED",
      },
      symbols: [],
      imports: [],
      exports: [],
      calls: [],
      internalRelations: [],
    };
  }

  const secretContent = "const apiKey = 'J8s2kLq9zX1pQw7vR3mNtYu5';\nexport const x = apiKey;\n";

  it("BLOCK policy excludes the file's source entirely", () => {
    const verdict = applySecurityPolicy(
      [{ path: "a.ts", entry: entry("a.ts"), content: secretContent }],
      {
        secretPolicy: "block",
        redactSecrets: true,
      },
    );
    expect(verdict.blockedFiles.has("a.ts")).toBe(true);
    expect(verdict.redactedContent.size).toBe(0);
  });

  it("WARN + redaction keeps the file but redacts values", () => {
    const verdict = applySecurityPolicy(
      [{ path: "a.ts", entry: entry("a.ts"), content: secretContent }],
      {
        secretPolicy: "warn",
        redactSecrets: true,
      },
    );
    expect(verdict.blockedFiles.size).toBe(0);
    const redacted = verdict.redactedContent.get("a.ts");
    expect(redacted).toBeDefined();
    expect(redacted).not.toContain("J8s2kLq9zX1pQw7vR3mNtYu5");
    expect(verdict.rawFindings.length).toBeGreaterThan(0);
  });

  it("WARN without redaction warns but keeps values (documented behavior)", () => {
    const verdict = applySecurityPolicy(
      [{ path: "a.ts", entry: entry("a.ts"), content: secretContent }],
      {
        secretPolicy: "warn",
        redactSecrets: false,
      },
    );
    expect(verdict.warnedFiles.has("a.ts")).toBe(true);
    expect(verdict.redactedContent.size).toBe(0);
  });

  it("ALLOW ignores findings", () => {
    const verdict = applySecurityPolicy(
      [{ path: "a.ts", entry: entry("a.ts"), content: secretContent }],
      {
        secretPolicy: "allow",
        redactSecrets: false,
      },
    );
    expect(verdict.blockedFiles.size).toBe(0);
    expect(verdict.warnedFiles.size).toBe(0);
    expect(verdict.safeFindings).toHaveLength(0);
  });

  it("blocks sensitive paths regardless of policy", () => {
    const verdict = applySecurityPolicy(
      [{ path: ".env.local", entry: entry(".env.local"), content: "DATABASE_URL=postgres://x\n" }],
      { secretPolicy: "warn", redactSecrets: true },
    );
    expect(verdict.blockedFiles.has(".env.local")).toBe(true);
  });
});

describe("verifyNoSecretLeaks (final gate)", () => {
  it("throws when a secret value survives into the payload", () => {
    const raw: SecretFinding[] = [
      {
        kind: "aws-access-key",
        filePath: "a.ts",
        line: 1,
        match: "AKIAIOSFODNN7EXAMPLE",
        description: "AWS access key id",
        confidence: "high",
      },
    ];
    expect(() =>
      verifyNoSecretLeaks(raw, "payload contains AKIAIOSFODNN7EXAMPLE inside"),
    ).toThrow();
    expect(() => verifyNoSecretLeaks(raw, "payload is clean")).not.toThrow();
  });
});
