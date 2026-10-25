# Security Policy

Offline Code Context Compiler (OCC) is committed to protecting developer source code and credentials. The extension runs entirely offline on the local machine and performs zero network communication.

For the full security model, threat matrix, git hardening proofs, and secret scanning mechanics, see [docs/SECURITY.md](docs/SECURITY.md).

## Supported Versions

| Version | Supported |
|---|---|
| 0.3.x | Yes |
| < 0.3.0 | No |

Versions up to 0.3.1 persisted secret-like tokens in local index shards. Schema version 3 clears older stores to eliminate legacy shards.

## Reporting a Vulnerability

If you discover a security vulnerability in this extension, do not open a public issue.

Submit reports via GitHub Private Vulnerability Reporting:
1. Navigate to `https://github.com/SpEXterXD/Code-Context/security/advisories`.
2. Click `Report a vulnerability`.
3. Include the extension version, operating system, and reproduction steps.

Repository Maintainer Setting:
This reporting channel requires the following GitHub setting to be enabled:
`Settings > Code security and analysis > Private vulnerability reporting > Enable`.
