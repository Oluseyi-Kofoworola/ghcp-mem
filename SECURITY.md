# GHCP-MEM Security

## Supported versions

| Version | Supported |
|---|---|
| 1.6.x (current) | ✅ |
| 1.5.x | Security fixes only |
| 1.4.x | Security fixes only |
| < 1.4.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via GitHub's built-in security advisory:

👉 [https://github.com/ITcredibl/ghcp-mem/security/advisories/new](https://github.com/ITcredibl/ghcp-mem/security/advisories/new)

Or email: **security@itcredibl.com**

Please include:
- A description of the vulnerability
- Steps to reproduce or a proof of concept
- The potential impact
- Your VS Code and GHCP-MEM versions

You will receive an acknowledgement within **48 hours** and a status update within **7 days**. We follow responsible disclosure — please give us time to patch before publishing.

## Security model

GHCP-MEM is designed with privacy and least-privilege in mind:

- **All data stays local** — no telemetry, no cloud sync, no outbound network calls beyond your existing GitHub Copilot subscription
- **No open ports** — the MCP server communicates via stdin/stdout only
- **Dual-pass redaction** — secrets are stripped at capture time and again at LM output time
- **Redact-on-import** — Memory Packs are re-redacted when imported from a third party
- **No native binaries** — zero compiled dependencies, zero supply-chain attack surface from native code
- **Workspace artifact is gitignored** — `.github/instructions/session-memory.instructions.md` is never committed unless you explicitly remove it from `.gitignore`
- **`<private>...</private>` blocks** are stripped before any persistence
- **Enterprise mode** — disables terminal capture, raw code snippets, MCP write tools, and team export
- **Preview-before-persist** — lets users inspect a compressed memory snapshot before storage
- **Policy sources** — remote redaction rules are treated as trusted admin inputs only

## Known limitations

- The LM compression call goes through your existing Copilot subscription (GitHub's servers). Do not include secrets in source code comments — while redaction is comprehensive, defence in depth means not relying on it exclusively.
- The `~/.ghcp-mem/sessions.json` mirror is a plaintext file on your filesystem, protected by OS-level user permissions only. Encrypt your home directory if you need additional protection.
