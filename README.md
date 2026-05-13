# 🧠 GHCP-MEM

### Persistent memory for GitHub Copilot. Built for VS Code, the enterprise, and Azure.

**Zero dependencies · Zero network ports · Native MCP · Secret-redacted by default**

[![VS Code Extension](https://img.shields.io/badge/VS_Code-1.93+-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-Native-24292e?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-7e3aed?style=for-the-badge)](https://modelcontextprotocol.io/)
[![Azure-aware](https://img.shields.io/badge/Azure-aware-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white)](#%EF%B8%8F-azure--enterprise)

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/ITcredibl/ghcp-mem/blob/main/LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.7-22c55e?style=flat-square)](https://github.com/ITcredibl/ghcp-mem/blob/main/CHANGELOG.md)
[![Tests](https://img.shields.io/badge/tests-94%20passing-22c55e?style=flat-square)](https://github.com/ITcredibl/ghcp-mem/tree/main/src/test)
[![Native deps](https://img.shields.io/badge/native_deps-0-22c55e?style=flat-square)](#-why-it-matters)
[![Network ports](https://img.shields.io/badge/network_ports-0-22c55e?style=flat-square)](#-privacy--security)
[![Redaction rules](https://img.shields.io/badge/redaction_rules-24-22c55e?style=flat-square)](#-privacy--security)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

---

## 🎯 What it is

**GHCP-MEM gives GitHub Copilot a persistent memory** across every session, file, and project — without spinning up a single sidecar, port, or native binary.

It captures what you actually do (edits, diagnostics, git, debug, tasks, terminal), compresses each session into a structured summary via the Copilot Language Model, scrubs secrets in a 24-rule dual-pass scanner, and quietly re-injects relevant prior context whenever you start a new conversation.

---

## 💡 Why it matters

Most "AI memory" tools were built for a single chat client and a single laptop. GHCP-MEM was built for **engineers who ship to production from VS Code** — often inside an enterprise, often on Azure, often on a machine with no admin rights, no Bun, no Python, and no open ports allowed.

### 🪶 Zero dependencies

No Bun. No uv. No Python. No SQLite binary. No WASM. No Chroma. No model downloads.

**Pure TypeScript on the VS Code API.**

### 🔌 Zero network ports

Nothing listens. Nothing phones home. No `:37777`. No `localhost` HTTP worker.

**Air-gap friendly. Audit-friendly.**

### 🤖 Native MCP + Copilot

Bundled stdio MCP server, `@mem` chat participant, and `#ghcpMemSearch` / `#ghcpMemStore` agent-mode tools.

**Speaks Copilot's protocol natively.**

---

## 📐 How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/pipeline.png" alt="GHCP-MEM capture pipeline: events → redactor → compressor → classifier → store → MCP / chat / agent tools" width="900">
</p>

> _Mermaid source: [docs/diagrams/pipeline.mmd](https://github.com/ITcredibl/ghcp-mem/blob/main/docs/diagrams/pipeline.mmd) · regenerate with `npm run render:diagrams`._

---

## 🏢 Enterprise & Azure

> **Note:** GHCP-MEM is the only memory layer in this category designed from day one for **enterprise developer machines** and **Azure-shop workflows**. The defaults are conservative; the surface is small; the data never leaves the box.

### 🔒 Built for locked-down machines

- **No admin install.** `.vsix` drops in like any other extension.
- **No outbound network.** No telemetry, no auto-updates, no cloud sync.
- **No native binaries.** Zero ABI surface to audit.
- **No open ports.** Nothing for a vuln scanner to flag.
- **Glob-based exclusion** of `.env*`, `*.pem`, `*.key`, `secrets/**`, `node_modules/**` by default.
- **`<private>...</private>` tags** are stripped before compression and never persisted.
- **All storage is per-user.** Lives in VS Code `globalState` + `~/.ghcp-mem/sessions.json`.
- **MIT licensed.** No copyleft, no per-seat fees, no commercial restrictions.

### ☁️ Built for Azure shops

- **12-subsystem classifier** auto-tags every edit and terminal command: `iac-bicep`, `iac-terraform`, `iac-arm`, `azd`, `functions`, `appservice`, `aks`, `containerapps`, `storage`, `keyvault`, `openai`, `az-cli`.
- **Live `az` snapshot** records subscription, tenant, RG, location, and up to 50 resource IDs.
- **`deployment` / `infra` observation types** auto-inferred from Azure signals (`azd up`, `az deployment`, `.bicep` / `.tf` edits).
- **`@mem /azure` slash command** groups Azure-tagged sessions by subsystem with `sub=… · rg=…` annotations.
- **8 Azure-specific redaction rules** (storage / Service Bus / Cosmos / SQL connection strings, SAS tokens, 88-char storage keys, SP secrets, subscription/tenant GUIDs).
- **Graceful degrade** — no `az` installed or not signed in? Records an informational note, never errors.

---

## ⭐ Features

### 📥 Automatic Capture

- File edits, creates, deletes, renames, opens, closes
- Diagnostics transitions (errors ↔ clean)
- Git state changes
- Debug sessions start / stop
- Task execution with exit codes
- Terminal commands (VS Code 1.93+ shell integration)
- All events debounced and rate-limited

### 🏷️ Observation Typing

Auto-classified into 12 types:

`feature` · `bugfix` · `refactor` · `docs` · `test` · `chore` · `research` · `config` · `security` · `deployment` · `infra` · `unknown`

`deployment` / `infra` inferred from Azure signals (`azd` / `az` cmds, `.bicep` / `.tf` edits).

### 🔒 Secret Redaction — 24 rules, dual-pass

**16 generic:** AWS access key + secret · GitHub PATs (classic + fine-grained) · npm tokens · OpenAI · Anthropic · Stripe live keys · Google API · Slack · JWT · Bearer tokens · DB connection URL passwords · PEM private key blocks · `password=` assignments · emails · IPv4 · credit cards

**8 Azure-specific:** Storage / Service Bus / Cosmos / SQL connection strings · SAS tokens · 88-char storage keys · SP secrets · subscription/tenant GUIDs

Plus `<private>...</private>` user-tagged blocks.

### 🔍 Hybrid Retrieval — RRF K=60

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/retrieval.png" alt="Hybrid retrieval: keyword + recency + embeddings fused via Reciprocal Rank Fusion (K=60), then Jaccard dedup" width="800">
</p>

### 🌳 Progressive Disclosure (token-efficient)

| Layer | Command | Tokens / result | Use |
|---|---|---|---|
| 1 (index) | `/search <query>` | ~100 | IDs, type, 1-line summary |
| 1b (timeline) | `/timeline <id\|window>` | ~150 | chronological window |
| 2 (detail) | `/detail <id-prefix>` | full | full session — only after filtering |

Inline filters: `@mem /search type:bugfix since:7d tag:auth login flow`

---

## 🎛️ Commands

<details open>
<summary><b>📋 17 commands organized by purpose</b></summary>

| Group | Command | Description |
|---|---|---|
| **Capture** | `GHCP-MEM: Capture Session Snapshot Now` | Manually trigger compression |
| | `GHCP-MEM: Compress Current Session` | Same, with progress notification |
| **Inspect** | `GHCP-MEM: Show Stored Context` | Markdown report of all sessions |
| | `GHCP-MEM: Show Memory Health Score` | 0–100 score breakdown with notes |
| **Backup / Restore** | `GHCP-MEM: Export Memory to JSON...` | Full backup |
| | `GHCP-MEM: Import Memory from JSON...` | Restore / merge |
| | `GHCP-MEM: Restore From Backup...` | Restore from rolling 5-snapshot backup |
| **Team Sharing (Packs)** | `GHCP-MEM: Export Memory Pack...` | Build a shareable `.ghcpmem-pack.json` |
| | `GHCP-MEM: Import Memory Pack...` | Install a pack from disk |
| | `GHCP-MEM: Uninstall Memory Pack...` | Remove every session belonging to a pack |
| **Chat** | `GHCP-MEM: Inject Relevant Context Into Copilot Chat...` | Copy top-N matches, open Chat |
| **Manage** | `GHCP-MEM: Delete Session...` | Remove a single session |
| | `GHCP-MEM: Tag Session...` | Add user tags |
| | `GHCP-MEM: Clear All Stored Context` | Wipe everything (irreversible) |
| **Azure** | `GHCP-MEM: Capture Azure Context Snapshot...` | Live `az` subscription/RG/resource IDs |
| | `GHCP-MEM: Seed Azure Demo Sessions` | 5 pre-tagged demo sessions |
| **MCP** | `GHCP-MEM: Show External MCP Client Config` | `mcp.json` snippets for other clients |

</details>

---

## 🛠️ Agent Mode Tools

Copilot's **agent mode** can call these tools automatically — no MCP server required.

| Tool | Inline reference | What it does |
|---|---|---|
| 🔍 `ghcpMem_search` | `#ghcpMemSearch <query>` | Search past sessions by keyword / type / date / tag |
| 💾 `ghcpMem_store` | `#ghcpMemStore <note>` | Persist a durable note (decisions, facts, preferences) |

---

## 💬 `@mem` Chat Participant

| Command | Example |
|---|---|
| `/status` | `@mem /status` |
| `/recent` | `@mem /recent` |
| `/search` | `@mem /search type:bugfix since:7d authentication` |
| `/timeline` | `@mem /timeline 72h` or `@mem /timeline <id>` |
| `/detail` | `@mem /detail a1b2c3d4` |
| `/azure` | `@mem /azure key-vault` |
| `/health` | `@mem /health` |

---

## ⚙️ Settings

<details>
<summary><b>🎚️ 11 configurable knobs</b></summary>

| Key | Default | Description |
|---|---|---|
| `ghcpMem.enabled` | `true` | Master switch |
| `ghcpMem.compressionIntervalMinutes` | `15` | Periodic compression |
| `ghcpMem.maxStoredSessions` | `50` | Count-based retention |
| `ghcpMem.retentionDays` | `90` | Age-based retention (`0` = off) |
| `ghcpMem.contextRetrievalCount` | `5` | Results injected into search |
| `ghcpMem.redactSecrets` | `true` | Secret/PII scanning |
| `ghcpMem.honorPrivateTags` | `true` | Strip `<private>...</private>` content |
| `ghcpMem.excludeGlobs` | `[".env*", "*.pem", "*.key", "secrets/**", "node_modules/**"]` | Skip these paths |
| `ghcpMem.autoInjectStartupContext` | `true` | Write `.github/instructions/*.md` (auto-gitignored) |
| `ghcpMem.healthAlertThreshold` | `30` | Warn at startup when memory health score falls below this value (`0` = off) |
| `ghcpMem.captureFileEdits` / `captureDiagnostics` / `captureTerminalCommands` / `captureGitOps` | `true` | Per-signal toggles |

</details>

---

## 🔌 External MCP Clients (Cursor, Cline, Windsurf, Claude Desktop)

GHCP-MEM mirrors its memory to `~/.ghcp-mem/sessions.json`. Any MCP-compatible client can read it via the bundled stdio server.

**`mcp.json` / `claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "ghcp-mem": {
      "command": "node",
      "args": ["/path/to/extension/out/mcpServer.js"]
    }
  }
}
```

Use `GHCP-MEM: Show External MCP Client Config` to get the exact resolved path.

**MCP tools exposed:**

- `ghcpMem_search(query, type?, sinceDays?, tag?, workspaceName?, limit?)` — RRF-fused keyword + recency search
- `ghcpMem_recent(limit?, workspaceName?)` — most recent sessions
- `ghcpMem_timeline(days?, limit?)` — chronological within a window
- `ghcpMem_get(id)` — full detail by ID or prefix

**Install VSIX:**

```bash
code --install-extension ghcp-mem-1.1.7.vsix
```

---

## 🏛️ Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/architecture.png" alt="GHCP-MEM module architecture — extension.ts orchestrates capture, redactor, compressor, store, MCP, chat, tree view, and agent tools" width="900">
</p>

<details>
<summary><b>📁 Module-by-module breakdown</b></summary>

| Module | Responsibility |
|---|---|
| [src/types.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/types.ts) | Event types, observation types, config reader, glob matcher, `AzureContextMeta` |
| [src/redactor.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/redactor.ts) | 24-rule secret/PII scanner (incl. 8 Azure rules), `<private>` tag stripper |
| [src/azureDetect.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/azureDetect.ts) | 12-subsystem classifier for file paths, terminal commands, and content |
| [src/azureContext.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/azureContext.ts) | `az` CLI wrapper (5-min cache, graceful fallback) — **fully tested** |
| [src/sessionCapture.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/sessionCapture.ts) | VS Code event hooks with debounce + exclude + redact + Azure tagging |
| [src/contextCompressor.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/contextCompressor.ts) | `vscode.lm` calls, rule-based fallback, observation-type classification, Azure context — **fully tested** |
| [src/contextStore.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/contextStore.ts) | Persistent DB, inverted index (async chunked rebuild), serial sync queue, retention, redact-on-import, rolling backups |
| [src/embeddings.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/embeddings.ts) | Feature-detected `vscode.lm.computeEmbeddings` helper |
| [src/ruleClassifier.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/ruleClassifier.ts) | Pre-LM observation typing |
| [src/autosave.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/autosave.ts) | Context-pressure autosave trigger |
| [src/health.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/health.ts) | 0–100 health score with configurable alert threshold |
| [src/packs.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/packs.ts) | Build / import (with redaction) / uninstall `.ghcpmem-pack.json` |
| [src/contextProvider.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/contextProvider.ts) | `@mem` chat participant with layered slash commands |
| [src/sessionsView.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/sessionsView.ts) | Activity bar tree view |
| [src/memoryTool.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/memoryTool.ts) | Agent-mode `ghcpMem_search` + `ghcpMem_store` tools |
| [src/mcpServer.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/mcpServer.ts) | Stand-alone stdio JSON-RPC server with workspace-scoped filtering |
| [src/extension.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/extension.ts) | Lifecycle, 17 commands, gitignore guard, health alert, top-level imports |
| [src/test/integration.test.ts](https://github.com/ITcredibl/ghcp-mem/blob/main/src/test/integration.test.ts) | End-to-end pipeline tests (compress → store → search → dedup → retention → import-redaction) |

</details>

---

## 🔐 Privacy & Security

> **Important:** All data stays on your machine. GHCP-MEM never opens a network port, never phones home, and never ships data to a third party.

- 🏠 **Storage:** VS Code `globalState` + atomic mirror to `~/.ghcp-mem/sessions.json`
- 🤖 **LM traffic:** your existing Copilot subscription only
- 🔒 **Redaction:** 24 rules, dual-pass (capture + LM output) plus redact-on-import for third-party packs
- 📁 **Workspace artifact:** only `.github/instructions/session-memory.instructions.md` — **auto-added to `.gitignore`** on first write
- 🛡️ **Attack surface:** VS Code extension host only — no subprocesses, no HTTP servers, no native modules

---

## 🩺 Troubleshooting

<details>
<summary><b>🚑 Common issues & fixes</b></summary>

| Symptom | Likely cause / fix |
|---|---|
| Status bar shows `MEM ●○○○○ 0` and never increments | No edits have triggered a snapshot yet. Run `Capture Session Snapshot Now`, or lower `ghcpMem.autosave.eventThreshold` to `3`. |
| `@mem` says "no Copilot language model available" | GitHub Copilot extension isn't installed / signed in. Compression and `@mem` chat need `vscode.lm`. Everything else still works. |
| `/azure` prints "Azure CLI not signed in" | Run `az login` once (cached 5 min). Also degrades gracefully if `az` isn't installed. |
| `~/.ghcp-mem/sessions.json` doesn't exist | Created on first successful persist — trigger one via `Capture Session Snapshot Now`. |
| MCP client can't see any tools | Bundled server is at `<extension-install-dir>/out/mcpServer.js`. Use `Show External MCP Client Config` to get the resolved path. |
| Terminal commands aren't captured | Requires VS Code shell integration. Enable `terminal.integrated.shellIntegration.enabled` + a supported shell. |
| Tests fail with `Cannot find module 'vscode'` | Run `npm install` first, then `npm test`. Mock is wired by [scripts/setup-test-env.js](https://github.com/ITcredibl/ghcp-mem/blob/main/scripts/setup-test-env.js). |
| Want to wipe everything | `Clear All Stored Context` + delete `~/.ghcp-mem/`. Backups stay in extension global storage under `backups/`. |

</details>

---

## 📜 License

MIT — see [LICENSE](https://github.com/ITcredibl/ghcp-mem/blob/main/LICENSE).

---

### Built for the GitHub Copilot ecosystem

[Report a bug](https://github.com/ITcredibl/ghcp-mem/issues) · [Request a feature](https://github.com/ITcredibl/ghcp-mem/issues) · [Live demo](https://github.com/ITcredibl/ghcp-mem/blob/main/docs/DEMO.md) · [Compare against other memory tools](https://github.com/ITcredibl/ghcp-mem/blob/main/docs/COMPARISON.md)

<sub>**v1.1.7** · 94 passing tests · zero native deps · zero ports · 24-rule redaction</sub>
