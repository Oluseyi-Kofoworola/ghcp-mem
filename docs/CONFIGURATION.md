# Baton — Configuration Reference

All settings live under the `baton` namespace and can be edited in VS Code Settings (`Ctrl+,` / `Cmd+,`) or directly in `settings.json`.

---

## Core

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.enabled` | boolean | `true` | Master switch — disable to pause all capture and injection. |
| `baton.scope` | `"user"` \| `"workspace"` \| `"repo"` | `"user"` | Retrieval scope. `user` = all sessions; `workspace` = current VS Code workspace only; `repo` = same git origin URL across machines. |
| `baton.githubCompatibleMode` | boolean | `false` | Mirror GitHub Copilot's agentic-memory contract: forces `retentionDays = 28` and `scope = repo`. Overrides those two settings when enabled. |

---

## Capture

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.captureFileEdits` | boolean | `true` | Capture file edit, create, delete, rename, open, and close events. |
| `baton.captureTerminalCommands` | boolean | `true` | Capture terminal activity (requires VS Code 1.93+ shell integration). |
| `baton.captureDiagnostics` | boolean | `true` | Capture error/warning diagnostic transitions. |
| `baton.captureGitOps` | boolean | `true` | Capture git state changes (branch, commit, merge, rebase). |
| `baton.excludeGlobs` | string[] | `["**/.env*", "**/*.pem", "**/*.key", "**/secrets/**", "**/node_modules/**"]` | Glob patterns whose file events are silently skipped. |

---

## Compression & autosave

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.compressionIntervalMinutes` | number (1–1440) | `15` | How often the timer-based compression job runs. |
| `baton.autosave.enabled` | boolean | `true` | Enable context-pressure autosave (flush when event count or wall clock threshold is hit). |
| `baton.autosave.eventThreshold` | number (1–10000) | `40` | Trigger autosave once this many events are buffered. |
| `baton.autosave.minutesThreshold` | number (1–1440) | `20` | Trigger autosave after this many minutes since the last flush (with any pending events). |

---

## Storage & retention

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.maxStoredSessions` | number (1–10000) | `50` | Maximum number of compressed sessions to keep. Oldest are evicted first when the cap is reached. |
| `baton.maxStoreSizeMB` | number (1–1024) | `25` | Soft cap on `~/.baton-mem/sessions.json` disk size. Oldest sessions are evicted until under cap (after count and age eviction). |
| `baton.retentionDays` | number (0–3650) | `90` | Delete sessions older than this many days. Set to `0` to disable age-based eviction. |

---

## Retrieval

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.contextRetrievalCount` | number (1–50) | `5` | Number of top-ranked past sessions to inject into startup context and `@baton` responses. |
| `baton.validateAgainstCodebase` | boolean | `true` | Drop or de-rank memories whose `keyFiles` no longer exist in the current workspace. |
| `baton.freshnessFloor` | number (0–1) | `0.25` | Minimum freshness score required for a memory to survive validation. Lower = more lenient. `0` = accept all. |

---

## Privacy & security

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.redactSecrets` | boolean | `true` | Run dual-pass redaction (24 patterns) on all captured text before storage. Strongly recommended. |
| `baton.honorPrivateTags` | boolean | `true` | Exclude content wrapped in `<private>...</private>` markers from persistence. |
| `baton.policySource` | string | `""` | Optional remote URL to a validated JSON array of redaction rules. Loaded on startup and after settings changes, then appended to the built-in policy set. |

---

## Notifications & health

| Setting | Type | Default | Description |
|---|---|---|---|
| `baton.autoInjectStartupContext` | boolean | `true` | On startup and after each compression, write `.github/instructions/session-memory.instructions.md` (Copilot auto-injection), `CLAUDE.md`, and `.cursor/rules` with recent session context. |
| `baton.startupContextSessionCount` | number | `5` | How many recent sessions (1–20) to include in the auto-injected instructions file. |
| `baton.healthAlertThreshold` | number (0–100) | `30` | Show a warning notification if the memory health score falls below this value. Set to `0` to disable. |

---

## Recommended configurations

### Minimal / quiet (reduce notifications and captures)

```json
{
  "baton.compressionIntervalMinutes": 30,
  "baton.autosave.eventThreshold": 80,
  "baton.healthAlertThreshold": 0,
  "baton.captureDiagnostics": false
}
```

### Maximum retention (power user)

```json
{
  "baton.maxStoredSessions": 500,
  "baton.maxStoreSizeMB": 100,
  "baton.retentionDays": 365,
  "baton.contextRetrievalCount": 10
}
```

### GitHub Copilot cloud parity

```json
{
  "baton.githubCompatibleMode": true
}
```

Forces 28-day retention and repo-scoped retrieval to match GitHub's hosted Copilot Memory behaviour.

### GitHub Copilot CLI + MCP

GitHub Copilot CLI can attach to the bundled stdio MCP server with its `/mcp` command. Use the extension command **Baton: Show External MCP Client Config** to copy the current server path, then add the same `node <extension>/out/mcpServer.js` command in Copilot CLI's MCP configuration.

### Repo-scoped team setup

```json
{
  "baton.scope": "repo",
  "baton.retentionDays": 60,
  "baton.maxStoredSessions": 200
}
```

---

[← Back to README](../README.md) · [Uninstall guide](UNINSTALL.md) · [Demo walkthrough](DEMO.md)
