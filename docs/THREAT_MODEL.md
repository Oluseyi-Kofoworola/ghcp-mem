# Baton Threat Model

> Status: **v1.6.0**, June 2026 · maintained alongside [SECURITY.md](../SECURITY.md)
>
> This document complements `SECURITY.md` (which is the reporting / disclosure / security-model summary) with a formal threat enumeration. The goal is to make every attack surface and every mitigation explicit, so enterprise reviewers can map our controls onto their own risk register without guessing.

We use a lightweight STRIDE pass over each major data-flow boundary. Where a mitigation is **not** in place we name it as an explicit residual risk rather than hiding it.

## 1. Trust boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│ Developer workstation (user account, OS file permissions)        │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  VS Code extension host process                          │  │
│   │   • src/sessionCapture.ts (event hooks)                  │  │
│   │   • src/redactor.ts        (24-rule SHA-256 hashing)     │  │
│   │   • src/contextCompressor  (vscode.lm)                   │  │
│   │   • src/contextStore.ts    (globalState + mirror)        │  │
│   │   • src/policySource.ts    (HTTPS fetch)                 │  │
│   │   • src/mcpServer.ts       (stdio JSON-RPC)              │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│   ┌────────────────────────────┐   ┌──────────────────────────┐ │
│   │ ~/.baton-mem/sessions.json  │   │ VS Code globalState      │ │
│   │ (atomic mirror, mode 0600) │   │ (per-user IDE storage)   │ │
│   └────────────────────────────┘   └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
        │ (1) https only, on user setting                     │
        │ (2) vscode.lm — through user's Copilot subscription │
        │ (3) stdio — only when an MCP client spawns us       │
        ▼                                                     ▼
  Corporate policy URL                              GitHub Copilot LM API
  (optional, HTTPS-validated)                       (existing user subscription)
```

Boundaries we cross:
- **B1** — Workspace files ↔ extension host (capture)
- **B2** — Extension host ↔ `vscode.lm` (compression)
- **B3** — Extension host ↔ `~/.baton-mem/sessions.json` (persistence)
- **B4** — Extension host ↔ corporate policy URL (optional, opt-in)
- **B5** — Extension host ↔ stdin/stdout of MCP client process (read or write tool calls)
- **B6** — Memory Pack file ↔ extension host (import path)

## 2. Asset inventory

| Asset | Where | Sensitivity |
|---|---|---|
| Session telemetry buffer | RAM, cap 5 MB / 5000 events | High while resident (raw snippets) |
| Compressed session record | `globalState` + `~/.baton-mem/sessions.json` | Medium (redacted summaries + key files) |
| Auto-injected brief | `.github/instructions/session-memory.instructions.md` | Medium (mirrored from above) |
| Rolling backups | extension `globalStorage/backups/*.json` | Medium |
| Policy URL config value | `settings.json` | Low (URL only, not credentials) |
| LM call payload | Network egress through Copilot subscription | High in flight (already redacted) |
| MCP client request | stdio | Medium |

## 3. STRIDE pass per boundary

### B1 — Workspace ↔ extension host (capture)

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T1** Spoofing — malicious workspace tricks extension into capturing a file outside the workspace | All capture paths flow through `vscode.workspace.asRelativePath` and `excludeGlobs`. No raw filesystem reads from arbitrary paths. | Low |
| **T2** Information disclosure — secrets in code, diffs, or terminal output captured then compressed | `src/redactor.ts` runs **before** any buffering. 24 rules cover AWS / GitHub / OpenAI / Anthropic / Stripe / npm / Slack / JWT / Bearer / DB URL / PEM / Azure (storage/SAS/keys/conn-strings/SP/sub-GUIDs). Each match is replaced with `[REDACTED:<label>]#<sha256-hash>`, never the raw bytes. `<private>...</private>` blocks are stripped pre-buffer. A second pass runs on the LM output. | Pattern coverage is finite — secret types not in the rule list are not redacted. Mitigated by `baton.customRedactionRules` + corporate `policySource`. |
| **T3** DoS — huge file paste or runaway terminal output blows extension-host memory | `sessionCapture.ts` enforces `MAX_VOLATILE_BYTES = 5 * 1024 * 1024` and `MAX_EVENTS = 5000`; oldest events are dropped on every `pushEvent`. File-edit batch flushes every 5 seconds. | Low |
| **T4** Tampering — workspace mutates a file during capture to confuse the analyzer | `semanticTextSignature()` is whitespace-normalised + SHA-256-keyed, so race-window edits yield a different signature on the next event and the loop converges. | Low |
| **T5** Repudiation — user later claims a memory was never created | Every stored session has a UUID, content hash, and timestamps; the audit command shows the full lineage. | Low |

### B2 — Extension host ↔ `vscode.lm` (Copilot compression)

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T6** Information disclosure — LM payload contains secrets despite first-pass redaction | LM input is the **already redacted** session data; a second redactor pass runs on the LM **output** too. Snippets are truncated to 200 chars and length-bounded before redaction. `baton.captureCodeSnippets=false` (enterprise mode) disables raw snippets entirely. | Medium-low — Copilot's terms of service govern Copilot data handling; Baton cannot bind that behaviour. Documented in `SECURITY.md`. |
| **T7** LM injection — attacker-controlled comment or string in the captured snippet alters the LM's structured output | The LM output is parsed into a typed `CompressedSession`; unknown fields are dropped; observation type is validated against a closed enum; arrays are length-clamped. | Low |
| **T8** Network exfil to non-Copilot endpoint | Baton only calls `vscode.lm.sendRequest`. There is no `fetch`, `http`, or `net` call to a Baton-owned backend. (Exception: `policySource` HTTPS GET, see B4.) Verifiable via `grep -nE "fetch\|http\\.\|https\\.\|net\\.\\|axios" src/`. | Low |

### B3 — Extension host ↔ `~/.baton-mem/sessions.json`

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T9** Information disclosure — another local user reads the file | Directory is created with mode `0700`, file with mode `0600`. | **High** if attacker has root or shared-account access. Mitigation: full-disk encryption + per-user OS account; optional encrypted store gated behind `baton.encryptLocalStore` is on the 1.5.x roadmap. |
| **T10** Tampering — attacker overwrites the file to inject false memories | Re-read at startup validates JSON structure + session UUIDs; corrupt sessions are quarantined. Backup-on-read keeps 5 rolling snapshots in `globalStorage/backups/` (separate from the mirror). | Medium — backup directory has same perms; not signed. |
| **T11** Disk exhaustion | `enforceSizeCap()` caps the on-disk store via `baton.maxStoreSizeMB` (default 25 MB) — evicts oldest sessions until under cap. Also `maxStoredSessions` count cap + `retentionDays` age cap. | Low |

### B4 — Extension host ↔ corporate policy URL

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T12** Untrusted URL — user is convinced to set `baton.policySource` to a malicious endpoint | `src/policySource.ts` validates the URL: must be http:/https: only, parseable, length-bounded. Fetched body is parsed as JSON, must be an array of `{pattern, replacement}` objects, regex patterns are compiled in a try/catch so a bad rule disables that rule alone. | Medium — a hostile policy URL **could** inject regex patterns that match `/.+/` and replace everything with a constant, effectively erasing all captured memory. Policy sources are treated as **trusted admin input** by design, like a Group Policy MSI; user UI guidance reflects this. |
| **T13** SSRF — corporate policy URL points at an internal IP / metadata service | Standard Node `fetch` enforces redirects but does not block private IP ranges. | Medium — relies on the user trusting their policy URL. Future hardening: opt-in allow-list of corporate domains. |
| **T14** Cache poisoning — stale policy persists | Policy is re-fetched on every extension activation; failures degrade to local rules with a console warning. | Low |

### B5 — Extension host ↔ MCP client (stdio)

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T15** Untrusted MCP client (e.g. Cursor / Cline / a malicious AI agent) issues a `baton_store` call with attacker-crafted payload | Input is validated against the tool's JSON schema; strings are length-bounded; `keyFiles` paths are normalised and rejected if they contain `..` or are absolute to another workspace. Redaction runs on every input field. `baton.allowMcpWriteAccess=false` (enterprise mode) disables write tools entirely. | Low to medium — write surface is narrow but exists. |
| **T16** `baton_search` returns memories from one workspace to a client running in a different workspace | MCP server filters by `workspaceId` / `workspaceName` when the client requests it. Without filter, all workspaces are searched (intended for cross-project recall). | Low — documented in README. |
| **T17** Stdio process is spawned without user knowledge | The MCP server is only spawned when the user configures an MCP client to launch it. There is no auto-spawn. | Low |

### B6 — Memory Pack imports

| Threat | Mitigation | Residual risk |
|---|---|---|
| **T18** Malicious `.ghcpmem-pack.json` from a teammate | Pack name is regex-validated; every session ID re-validated as UUID; **every session is re-run through the redactor on import** (defense in depth, even if the pack was already redacted on export). Schema version is checked. | Low |
| **T19** Disk exhaustion via pack size | Standard JSON parse + the `maxStoreSizeMB` cap apply on any imported session. | Low |

## 4. Out-of-scope (by design)

These are **not** threats Baton tries to defend against; users with these requirements should layer other controls:

- **Compromised VS Code extension host** — if a malicious extension is running in the same host, it can read any other extension's `globalState`. This is a VS Code-platform-level concern.
- **Compromised user OS account** — see T9. Mitigation is full-disk encryption.
- **Copilot subscription terms** — Baton cannot constrain what GitHub does with the LM payload after it leaves the extension; the user's existing subscription terms govern that.
- **Network-level observation** between the extension host and Copilot's LM endpoint — this is the same trust as any other Copilot operation; no Baton-specific risk added.
- **Backdoored npm dependency** — covered separately by `dependabot.yml`, `npm audit --audit-level=high` CI gate, `gitleaks`, `semgrep`, CodeQL, and SBOM publishing in release workflow. SLSA L3-style provenance is attested on every release via `actions/attest-build-provenance`.

## 5. Roadmap residual risks

These are tracked publicly and addressed in upcoming releases:

| Risk | Current state | Targeted in |
|---|---|---|
| **R1** Plaintext local store (T9) | Mode 0600 + OS perms only | `baton.encryptLocalStore` opt-in via `vscode.SecretStorage`-backed AES-256-GCM key — **1.5.x** |
| **R2** Policy URL allow-list (T13) | Any HTTPS URL accepted | Optional domain allow-list + signature verification — **1.6.x** |
| **R3** Pack import provenance (T18) | Re-redacted but not signed | Optional Sigstore signature verification on pack files — **1.6.x** |

## 6. How to verify any of this

Every claim above maps to source you can audit:

```bash
# T2 — redactor rules and SHA-256-hashed replacements
grep -nE 'hashedTag|REDACTED' src/redactor.ts

# T3 — volatile buffer caps
grep -nE 'MAX_VOLATILE_BYTES|MAX_EVENTS|trimEvents' src/sessionCapture.ts

# T8 — no Baton-owned network calls
grep -rnE "fetch\(|require\(.https?.\)|axios" src/ | grep -v policySource

# T9, T11 — file mode + size cap
grep -nE 'mode: 0o[67]00|maxStoreSizeMB|enforceSizeCap' src/contextStore.ts

# T12 — policy URL validation
grep -nE 'validatePolicy|http:|https:' src/policySource.ts

# T18 — pack redaction on import
grep -nE 'redact|importPack' src/packs.ts
```

## 7. Reporting & disclosure

See [SECURITY.md](../SECURITY.md) for vulnerability reporting, supported versions, and disclosure timelines. A vulnerability that bypasses any control listed here is in-scope for our coordinated-disclosure process.
