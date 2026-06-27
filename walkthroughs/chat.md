# Chat with your memory

GHCP-MEM registers a Copilot chat participant named **@mem** with progressive-disclosure commands:

| Command              | What it does                                                      |
| -------------------- | ----------------------------------------------------------------- |
| `@mem /status`       | Show memory store stats (session count, pending events, health)   |
| `@mem /recent`       | Show the most recent sessions                                     |
| `@mem /search foo`   | Keyword search with RRF (recency + match) ranking                 |
| `@mem /timeline 7d`  | Sessions within a time window                                     |
| `@mem /detail <id>`  | Full session detail by ID prefix                                  |
| `@mem /azure`        | Azure-tagged sessions grouped by subsystem                        |
| `@mem /export <id>`  | Diff-friendly markdown export (paste into PRs)                    |
| `@mem /health`       | Memory health score with redaction coverage & retention headroom  |
| `@mem /savings`      | Lifetime token savings breakdown with dollar-equivalent           |
| `@mem /related`      | Sessions that touched the currently open file                     |
| `@mem /decisions`    | ADR-style decision log deduped across all sessions                |
| `@mem /standup`      | AI-generated daily standup note from yesterday's sessions         |
| `@mem /commit`       | AI conventional commit message from staged diff + session history |
| `@mem /ask <q>`      | RAG Q&A — cited answer from matching session history              |
| `@mem /recap 7d`     | Narrative engineering recap (7d · 30d · 90d) for sprint retros   |
| `@mem /whereami`     | Interruption-recovery brief — what you were doing, where you left off, your next step |
| `@mem /debt`         | Technical debt ledger — TODO/FIXME/HACK signals from sessions, grouped by age |
| `@mem /adr [topic]`  | Generate a formal Architecture Decision Record from session history |
| `@mem /pr [branch]`  | PR review context — sessions matching the PR's changed files      |
| `@mem /precommit`    | Pre-commit check — verify staged changes against past architectural decisions |

## Inline filters

Search and timeline accept inline filters:

```
@mem /search type:feature since:7d tag:wip auth refactor
```

## Beyond Copilot

GHCP-MEM also ships a JSON-RPC stdio MCP server (`node out/mcpServer.js`) so non-Copilot agents (Claude Code, Cline, etc.) can query the same memory. The server exposes 14 tools, including `ghcpMem_search`, `ghcpMem_recent`, `ghcpMem_timeline`, `ghcpMem_get`, `ghcpMem_store`, `ghcpMem_delete`, `ghcpMem_entity`, `ghcpMem_snippets`, `ghcpMem_conflicts`, `ghcpMem_lineage`, `ghcpMem_explain`, `ghcpMem_graph`, `ghcpMem_route`, and `ghcpMem_lessons`.
