# Capture a snapshot

Baton normally captures activity automatically every 15 minutes (configurable via `baton.compressionIntervalMinutes`).

When you want to snapshot _right now_ — say, before a refactor — run **Baton: Capture Session Snapshot Now** from the command palette, or click the camera icon at the top of the Sessions view.

## What gets stored

| Field          | Source                                            |
| -------------- | ------------------------------------------------- |
| Summary        | LLM-compressed via `vscode.lm` (Copilot Chat)     |
| Key files      | Files you opened or edited                        |
| Key topics     | Inferred from file paths + edits                  |
| Decisions      | Extracted from your chat exchanges                |
| Redactions     | API keys, tokens, connection strings, PII removed |

Nothing leaves your machine — it's stored under `~/.baton-mem/sessions.json` and mirrored to VS Code's `globalState`.
