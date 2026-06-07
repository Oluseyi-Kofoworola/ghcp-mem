# Chat with your memory

Baton registers a Copilot chat participant named **@baton** with progressive-disclosure commands:

| Command              | What it does                                                      |
| -------------------- | ----------------------------------------------------------------- |
| `@baton /status`       | Show memory store stats (session count, pending events, health)   |
| `@baton /recent`       | Show the most recent sessions                                     |
| `@baton /search foo`   | Keyword search with RRF (recency + match) ranking                 |
| `@baton /timeline 7d`  | Sessions within a time window                                     |
| `@baton /detail <id>`  | Full session detail by ID prefix                                  |
| `@baton /azure`        | Azure-tagged sessions grouped by subsystem                        |
| `@baton /export <id>`  | Diff-friendly markdown export (paste into PRs)                    |
| `@baton /health`       | Memory health score with redaction coverage & retention headroom  |
| `@baton /savings`      | Lifetime token savings breakdown with dollar-equivalent           |
| `@baton /related`      | Sessions that touched the currently open file                     |
| `@baton /decisions`    | ADR-style decision log deduped across all sessions                |
| `@baton /standup`      | AI-generated daily standup note from yesterday's sessions         |
| `@baton /commit`       | AI conventional commit message from staged diff + session history |
| `@baton /ask <q>`      | RAG Q&A — cited answer from matching session history              |
| `@baton /recap 7d`     | Narrative engineering recap (7d · 30d · 90d) for sprint retros   |
| `@baton /whereami`     | Interruption-recovery brief — what you were doing, where you left off, your next step |
| `@baton /debt`         | Technical debt ledger — TODO/FIXME/HACK signals from sessions, grouped by age |
| `@baton /adr [topic]`  | Generate a formal Architecture Decision Record from session history |
| `@baton /pr [branch]`  | PR review context — sessions matching the PR's changed files      |
| `@baton /precommit`    | Pre-commit check — verify staged changes against past architectural decisions |

## Inline filters

Search and timeline accept inline filters:

```
@baton /search type:feature since:7d tag:wip auth refactor
```

## Beyond Copilot

Baton also ships a JSON-RPC stdio MCP server (`node out/mcpServer.js`) so non-Copilot agents (Claude Code, Cline, etc.) can query the same memory. The server exposes 6 tools: `baton_search`, `baton_recent`, `baton_timeline`, `baton_get`, `baton_store`, and `baton_delete`.
