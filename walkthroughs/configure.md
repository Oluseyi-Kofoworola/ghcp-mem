# Tuning Baton

All settings live under **Baton** in VS Code Settings.

## Retention & disk budget

| Setting                       | Default | What it controls                                          |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `baton.retentionDays`       | 90      | Age-based eviction                                        |
| `baton.maxStoredSessions`   | 50      | Count-based eviction                                      |
| `baton.maxStoreSizeMB`      | 25      | Soft byte cap on `~/.baton-mem/sessions.json`              |

All three apply in order: age → count → size. The most conservative bound wins.

## Retrieval scope

| Setting                             | Default       | What it controls                                                     |
| ----------------------------------- | ------------- | -------------------------------------------------------------------- |
| `baton.scope`                     | `"user"`      | `user` = all sessions · `workspace` = current VS Code workspace only · `repo` = same git origin across machines |
| `baton.contextRetrievalCount`     | 5             | Number of past sessions injected into each search result             |
| `baton.validateAgainstCodebase`   | true          | Drop sessions whose key files no longer exist in the workspace       |
| `baton.freshnessFloor`            | 0.25          | Minimum fraction of key files that must still exist (0–1)            |

## Capture controls

| Setting                             | Default | What it controls                          |
| ----------------------------------- | ------- | ----------------------------------------- |
| `baton.captureFileEdits`          | true    | Record file edit events                   |
| `baton.captureTerminalCommands`   | true    | Record terminal commands (requires shell integration) |
| `baton.captureDiagnostics`        | true    | Record error/warning diagnostic changes   |
| `baton.captureGitOps`             | true    | Record git operations                     |

## Autosave

| Setting                             | Default | What it controls                                                     |
| ----------------------------------- | ------- | -------------------------------------------------------------------- |
| `baton.autosave.enabled`          | true    | Enable context-pressure autosave                                     |
| `baton.autosave.eventThreshold`   | 40      | Trigger a flush after this many buffered events                      |
| `baton.autosave.minutesThreshold` | 20      | Trigger a flush after this many minutes since last save              |

## Health alerting

| Setting                        | Default | What it controls                                                        |
| ------------------------------ | ------- | ----------------------------------------------------------------------- |
| `baton.healthAlertThreshold` | 30      | Show a startup warning when the memory health score falls below this value (0 = off) |

## Privacy

| Setting                          | Default | What it controls                                       |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `baton.redactSecrets`          | true    | API keys, tokens, conn strings, PEM blocks, JWTs       |
| `baton.honorPrivateTags`       | true    | Strip text inside `<private>...</private>` markers     |
| `baton.excludeGlobs`           | see settings | Glob patterns whose file events are skipped entirely |

## GitHub-compatible mode

Toggle `baton.githubCompatibleMode` to mirror GitHub Copilot's agentic-memory contract:

- 28-day retention (overrides `retentionDays`)
- Repo-scoped retrieval by default (overrides `scope`)

Useful when you want behaviour parity with the hosted Copilot memory product.
