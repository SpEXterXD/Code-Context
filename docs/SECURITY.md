# Security Policy and Threat Model

Offline Code Context Compiler (OCC) runs entirely on the local machine without outbound network connections, third-party analytics, or background telemetry. This document defines the threat model, security boundaries, secret detection mechanisms, git execution hardening, and vulnerability reporting procedures.

## Threat Model

| Asset | Threat | Mitigation | Residual Risk |
|---|---|---|---|
| Repository Credentials (API keys, tokens, private keys) | Exfiltration via generated context pasted into external LLM interfaces | Automated pattern scanning, Shannon entropy detection, BLOCK/WARN/ALLOW policies, deterministic redaction, and fail-closed leak gate | Novel credential formats, short or low-entropy secrets, and multi-token fragmented secrets may pass undetected |
| Developer Environment | Remote code execution via malicious repository configuration when spawning git | `safeGit` execution hardening with disabled fsmonitor, hooks, diff drivers, textconv filters, and external transports; trust gating | Git features must be enabled by user; untrusted workspaces disable git entirely |
| LLM Reasoning Integrity | Prompt injection via malicious repository comments or files (for example, "Ignore previous instructions") | Repository source code is strictly segregated inside the `## SOURCE` section under an inert data banner with dynamic fence lengths | The external model reading the exported package is responsible for distinguishing data from system instructions |
| Local Disk Index Storage | Persistence of sensitive credentials in on-disk index shards | Prior to token harvesting, secret spans matching scanner patterns are blanked with whitespace | Values not flagged by the scanner (such as low-entropy passwords) remain tokenized; key-type prefixes remain |
| Supply Chain Dependencies | Malicious dependencies executing during extension activation | The only runtime dependency is `typescript`; zero network dependencies; ESLint boundary rules prohibit network modules | Vulnerabilities in VS Code core extension host or upstream TypeScript compiler |

## Privacy and Network Isolation

OCC operates under strict network isolation:
1. Zero Network Sockets: The codebase imports no networking modules (`http`, `https`, `net`, `dgram`, `dns`). This is verified by architectural boundary checks in test suites.
2. Zero Telemetry: No telemetry pings, error tracking services, or usage analytics are included.
3. User-Initiated Egress: The sole export mechanism is the manual copy command that writes text to the local system clipboard. OCC never transmits context packages automatically.

## Secret Detection and Redaction Engine

Files selected for a context package are evaluated by `SecretScanner` (`src/security/secretScanner.ts`) prior to budget packing:

### Pattern Families
The scanner matches known high-risk token structures:
- AWS access key IDs (`AKIA[0-9A-Z]{16}`)
- GitHub personal access tokens (`ghp_[0-9A-Za-z]{30,}`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- Slack bot and user tokens (`xox[baprs]-[0-9A-Za-z-]{10,}`)
- Stripe secret keys (`sk_live_[0-9A-Za-z]{10,}`, `rk_live_`)
- Google API keys (`AIza[0-9A-Za-z-_]{35}`)
- OpenAI API keys (`sk-[0-9A-Za-z]{20,}`)
- Private key headers (`-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----`)
- JSON Web Tokens (three base64 segments matching JWT structure)
- Credentialed URLs (HTTP, HTTPS, Postgres, MySQL, MongoDB, Redis URLs containing embedded passwords)

### Entropy Rule
For generic assignments (such as `password = "..."`, `secret = "..."`, or `.env` key-value lines), the engine computes Shannon entropy over the candidate value. Strings exceeding entropy thresholds without matching common non-secret word lists are flagged as potential credentials. Known placeholder values (such as `changeme`, `dummy`, `localhost`, `${VAR}`) are excluded to limit false positives.

### Policies: BLOCK, WARN, and ALLOW

The `offlineCodeContext.secretPolicy` setting governs how detected secrets are handled:

- `block` (default): The file's source code is entirely excluded from the `## SOURCE` section. The file remains visible in the `## WHY THESE FILES WERE SELECTED` section with the note `excluded by security policy (block)`, ensuring visibility without data leakage.
- `warn`: Source code is included in the package. If `offlineCodeContext.redactSecrets` is true (default), every matching credential string is replaced with a deterministic placeholder: `[REDACTED:<type>:<hash8>]`. The replacement is irreversible. If `redactSecrets` is false, source text is emitted verbatim and findings are reported.
- `allow`: Findings are ignored and source code is included unredacted. This mode is strongly discouraged.

### Fail-Closed Leak Gate
Before any context package is displayed in the preview editor or written to the clipboard, `verifyNoSecretLeaks()` (`src/security/securityService.ts`) performs a final pass over the serialized string. If any raw credential value identified during scanning appears in the output, context generation throws `SECURITY_BLOCKED` and aborts the export.

## Sensitive Path Rules

Files matching sensitive path conventions are excluded from indexing and context assembly by default:
- Environment files: `.env`, `.env.*`
- Cryptographic keys: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- Credential stores: `.npmrc`, `.netrc`, `.git-credentials`
- Shell history: `.bash_history`, `.zsh_history`

If a file matching these patterns is requested directly, sensitive path rules intercept the request and block the content from being read.

## Local Index Storage and Secret Token Blanking

The local index store persists parsed syntax structures and lexical tokens to local disk inside the VS Code workspace storage directory.

### Secret-Token Blanking
In versions 0.3.2 and later, file text is screened using `SecretScanner.scanSpans()` before tokenization. Spans matching credential patterns are overwritten with whitespace before harvesting `identifiers`, `bodyTokens`, and `fileSummary`. This guarantees that high-entropy credentials do not enter on-disk index shards.

### Stated Limit of Token Filtering
Token filtering blanks only patterns identified by the scanner. Values that the scanner does not flag, such as low-entropy passwords, custom tokens, or split credentials, are still tokenized. Furthermore, word-like fragments such as key-type prefixes (for example, `AKIA`, `ghp`, or `sk_live`) remain in the index.

Versions up to 0.3.1 persisted secret-bearing tokens in the local index store. To address this, schema version 3 (`STORE_SCHEMA_VERSION = 3`) clears and rebuilds any existing store from earlier versions on first run.

## Git Hardening and Execution Hazards

OCC runs git for read-only metadata: commit recency (`enableGitRecency`) and working-tree change detection (`changeSeeds`).

To prevent malicious repositories from executing arbitrary code via git hooks or configuration, all invocations pass through `safeGit` (`src/git/safeGit.ts`) with hard execution boundaries:

1. Global Execution Overrides: Every git invocation injects configuration flags to neutralize execution hooks:
   `-c core.fsmonitor=false -c core.hooksPath=<emptyDir> -c gc.auto=0 -c core.pager=cat -c protocol.ext.allow=never`
2. Diff Driver Overrides: Diff operations explicitly pass `--no-ext-diff --no-textconv` to neutralize repository-configured `diff.external` and `textconv` binaries.
3. No Shell Spawning: Processes are launched via `child_process.execFile` with argument arrays. No shell interpreter is invoked.
4. Process Timeouts: Commands enforce strict timeouts and run with `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`.

### Empirical Hazard Verification
Running `npm run eval:fsmonitor-repro` and `npm run eval:seed-hazard-repro` demonstrates the efficacy of these mitigations:
- `core.fsmonitor`: Raw `git status` executes repository-configured fsmonitor binaries (`MARKER WRITTEN`); `safeGit` neutralizes the hazard (`no marker`, exit code 0).
- `diff.external`: Raw `status` and `diff` execute external diff drivers (`EXECUTED`); `safeGit` with `--no-ext-diff` neutralizes execution (`not executed`).
- `textconv`: Raw status executes textconv converters (`EXECUTED`); `safeGit` with `--no-textconv` neutralizes execution (`not executed`).
- `clean` and `smudge` filters: Neutralized by `safeGit` argument flags (`not executed`).

## Workspace Trust Behavior

OCC declares limited untrusted workspace support (`untrustedWorkspaces.supported: "limited"` in `package.json`):
- Untrusted Workspaces: If a workspace is not trusted (`vscode.workspace.isTrusted === false`), all git features are completely disabled. No git child processes are spawned under any circumstances. Indexing, AST parsing, and context generation remain fully operational.
- Trust Granted: When the user grants workspace trust via `onDidGrantWorkspaceTrust`, git features become available if enabled in settings.

## Supported Versions Policy

- Extension Versions: Security fixes and maintenance patches are provided for the latest released minor version. Published git tags are never moved; fixes ship as new patch versions.
- VS Code Compatibility: Requires VS Code engine version 1.85.0 or later.
- Node Compatibility: Tested on Node versions 18, 20, and 24 across Linux, macOS, and Windows.

## Vulnerability Reporting

If you identify a security vulnerability in Offline Code Context Compiler, do not submit a public issue or discussion.

Use GitHub Private Vulnerability Reporting:
1. Navigate to the repository on GitHub: `https://github.com/SpEXterXD/Code-Context`.
2. Click the `Security` tab below the repository name.
3. In the left navigation, select `Advisories`.
4. Click `Report a vulnerability` to open the private disclosure form.
5. Provide a detailed summary, affected extension versions, proof of concept, and reproduction steps.

Repository Maintainer Configuration Note:
To receive vulnerability reports, the repository maintainer must enable the following setting on GitHub:
`Settings > Code security and analysis > Private vulnerability reporting > Enable`.
Do not send security reports via public email addresses.
