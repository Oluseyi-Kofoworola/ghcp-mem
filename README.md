# 🧠 GHCP-MEM

### Stop paying tokens to re-explain your own project

**Every new AI session re-reads your files, re-learns your architecture, and re-discovers your decisions — burning tokens on work it already did last session.**  
GHCP-MEM stops that waste. It compresses what happened, stores it locally, and hands it back to Copilot so the tokens go to actual work — not catch-up.

**Zero dependencies · Zero network ports · Native Copilot + MCP · Secret-redacted by default**

[![VS Code Extension](https://img.shields.io/badge/VS_Code-1.93+-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-Native-24292e?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-7e3aed?style=for-the-badge)](https://modelcontextprotocol.io/)
[![Azure-aware](https://img.shields.io/badge/Azure-aware-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white)](#enterprise--azure)

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ITcredibl.ghcp-mem?label=marketplace&color=007ACC&style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem)
[![Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/ITcredibl.ghcp-mem?label=installs&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem)
[![Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/ITcredibl.ghcp-mem?label=downloads&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem)
[![Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/ITcredibl.ghcp-mem?label=rating&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/ITcredibl/ghcp-mem/blob/main/LICENSE)
[![Contributing](https://img.shields.io/badge/contributing-guide-orange?style=flat-square)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/security-policy-red?style=flat-square)](SECURITY.md)

---

## Why this exists

Every time you open a new Copilot chat, the AI starts from zero.

Before it can help, it burns tokens just to answer three questions:

- **What are you building?** (re-reads files, structure, stack)
- **How does it work?** (re-reads architecture, patterns, decisions)
- **Why did you do it this way?** (re-reads history it has no memory of)

That catch-up tax is invisible, constant, and completely avoidable.

GHCP-MEM stores a compressed record of your actual work — what you changed, decided, fixed, and deployed. The next session, Copilot already knows the answers. Tokens go to moving forward, not catching up.

---

## What the waste looks like

| Every new session… | The real cost |
|---|---|
| AI re-reads files to understand what you're building | Tokens spent on catch-up, not code |
| AI re-discovers your architecture and past decisions | You repeat the same explanations again |
| AI re-learns why a change was made | It guesses, and sometimes guesses wrong |
| Most "memory" tools need ports, sidecars, or cloud sync | New risk, new complexity, new failure point |

The result: a significant slice of every Copilot session is wasted on context the AI already had last time.

---

## How GHCP-MEM solves it

**GHCP-MEM gives Copilot a persistent memory layer so it never needs to re-learn what it already knew.**

It captures what you do in each session, compresses it into structured memory, redacts secrets before storage, and hands that context back to Copilot at the start of every session — automatically, locally, for free.

The AI already knows the *what*, *how*, and *why*. Every token goes to actual work.

It surfaces memory through:

- the **`@mem`** chat participant (15 commands including `/savings` to see tokens recovered)
- native Copilot **agent tools** (`#ghcpMemSearch`, `#ghcpMemStore`)
- a bundled **stdio MCP server** for Cursor, Cline, Windsurf, and Claude Desktop

Why engineers trust it:

| What GHCP-MEM does | Why it matters |
|---|---|
| **Eliminates catch-up tokens** | Copilot already knows your project from prior sessions |
| **Runs with zero native dependencies** | No Bun, Python, SQLite binary, WASM, Chroma, or model downloads |
| **Opens zero network ports** | Nothing listens on localhost. Nothing phones home |
| **Stores data locally** | Memory stays on your machine under your control |
| **Redacts secrets by default** | 24-rule dual-pass redaction plus `<private>...</private>` stripping |
| **Understands Azure workflows** | Azure subsystem tagging, live `az` snapshotting, Azure-specific redaction |

---

## How it works

### Step 1: Install it

> **Live on the VS Code Marketplace** — one-click install, auto-updates included.

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem">
    <img src="https://img.shields.io/badge/Install_from_Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install from VS Code Marketplace" height="36">
  </a>
  &nbsp;
  <a href="vscode:extension/ITcredibl.ghcp-mem">
    <img src="https://img.shields.io/badge/Open_in_VS_Code-22c55e?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Open in VS Code" height="36">
  </a>
</p>

| Method | Steps |
|---|---|
| **Marketplace (recommended)** | Install from the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=ITcredibl.ghcp-mem). |
| **Inside VS Code** | Open Extensions (`⇧⌘X` / `Ctrl+Shift+X`), search **GHCP-MEM**, click **Install**. |
| **Command line** | `code --install-extension ITcredibl.ghcp-mem` |
| **Offline / air-gapped** | Download a [`.vsix` from Releases](https://github.com/ITcredibl/ghcp-mem/releases) and run `code --install-extension ghcp-mem-<version>.vsix` |

### Step 2: Let it capture your work

GHCP-MEM records the signals that matter in a coding session:

- file edits, creates, deletes, renames, opens, closes
- diagnostics transitions
- git changes
- debug session start and stop
- task runs with exit codes
- terminal commands through VS Code shell integration

Then it debounces, redacts, classifies, and compresses those events into structured memory.

### Step 3: Ask for the right memory at the right time

Use:

- `@mem /recent`
- `@mem /search`
- `@mem /timeline`
- `@mem /detail`
- `#ghcpMemSearch`
- `#ghcpMemStore`

Or connect the bundled MCP server from clients like Cursor, Cline, Windsurf, or Claude Desktop.

---

## Get started

Stop burning tokens on catch-up. Install GHCP-MEM and capture your first snapshot:

1. Install **GHCP-MEM**
2. Open any workspace
3. Run **`GHCP-MEM: Capture Session Snapshot Now`**
4. Open Copilot Chat and try **`@mem /recent`**
5. Run **`@mem /savings`** after a few sessions to see exactly how many tokens you've recovered

<details>
<summary><b>📺 Watch the install in 5 seconds</b></summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/demo/install-animation.gif" alt="Animated terminal: code --install-extension ITcredibl.ghcp-mem then installed successfully" width="720">
</p>

</details>

---

## Why teams need this

Without persistent session memory, every session charges the same hidden tax:

- tokens burned re-explaining what the project does
- tokens burned re-establishing architecture and patterns
- tokens burned re-learning why a decision was made
- more tokens spent on the same work, slower progress, worse answers

GHCP-MEM eliminates that tax. **The tokens you stop wasting on catch-up are the tokens that get your work done.**

---

## What success looks like

With GHCP-MEM, the catch-up tax disappears:

- **Copilot already knows what you're building** — no re-reading files to get oriented
- **Copilot already knows how it works** — architecture and patterns are in memory
- **Copilot already knows why you made those choices** — decisions persist across sessions
- you resume work in seconds instead of spending the first 10 minutes re-explaining
- enterprise machines stay compliant — no ports, no cloud, no native binaries
- Azure-heavy teams get memory that understands their stack natively
- **`@mem /savings` shows exactly how many tokens were recovered** and the dollar-equivalent at GPT-4o pricing

That is the outcome: **tokens go to building, not catching up.**

---

## See it in action

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/demo/pipeline-animation.gif" alt="Animated GHCP-MEM pipeline: edits flow through redaction and compression, then return as recalled memory in chat" width="900">
</p>

**What happens:** every edit, diagnostic, git op, and terminal command is debounced, scrubbed of secrets, summarized through your existing Copilot LM, and stored locally. Later, GHCP-MEM recalls the most relevant prior context in milliseconds.

---

## Core features

### Automatic capture

- File edits, creates, deletes, renames, opens, closes
- Diagnostics transitions
- Git state changes
- Debug sessions
- Task execution with exit codes
- Terminal commands (VS Code 1.93+ shell integration)
- Debounced and rate-limited capture

### Observation typing

GHCP-MEM classifies sessions into:

`feature` · `bugfix` · `refactor` · `docs` · `test` · `chore` · `research` · `config` · `security` · `deployment` · `infra` · `unknown`

Azure signals such as `azd`, `az`, `.bicep`, and `.tf` edits influence `deployment` and `infra` inference automatically.

### Secret redaction

**16 generic patterns** including:

- AWS access key and secret
- GitHub PATs
- npm tokens
- OpenAI and Anthropic keys
- Stripe live keys
- Google API keys
- Slack tokens
- JWT and Bearer tokens
- DB URL passwords
- PEM private key blocks
- `password=` assignments
- emails, IPv4 addresses, and credit cards

**8 Azure-specific patterns** including:

- Storage, Service Bus, Cosmos, and SQL connection strings
- SAS tokens
- 88-character storage keys
- service principal secrets
- subscription and tenant GUIDs

Also strips user-tagged `<private>...</private>` blocks before persistence.

### Hybrid retrieval

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/retrieval.png" alt="Hybrid retrieval with keyword, recency, embeddings, and rank fusion" width="800">
</p>

Retrieval blends keyword search, recency, embeddings when available, and deduplication so the right memories surface first.

### Progressive disclosure

| Layer | Command | Use |
|---|---|---|
| **Index** | `/search <query>` | short summaries and IDs |
| **Timeline** | `/timeline <window>` | chronological context around a date or session |
| **Detail** | `/detail <id-prefix>` | full session only after filtering |

This keeps memory useful without dumping huge amounts of text into every prompt.

### Visual Timeline

**`GHCP-MEM: Open Visual Timeline`** (`⌥⌘M` → Command Palette) opens a full WebviewPanel timeline — color-coded by observation type, searchable by keyword or branch, with expandable session cards.

### Session CodeLens

A `📚 N sessions touched this file` lens appears at the top of every opened source file. Click it to open a quick-pick of sessions that edited the same path, pre-sorted by recency.

### AI-powered chat commands

| Command | What it generates |
|---|---|
| `@mem /standup` | Daily standup note from yesterday's sessions |
| `@mem /commit` | Conventional commit message from staged diff + recent sessions |
| `@mem /ask <question>` | Cited answer pulled from matching sessions via RAG |
| `@mem /recap [7d\|30d\|90d]` | Narrative engineering recap for sprint retros |
| `@mem /related` | Sessions that touched the active file, grouped by recency |
| `@mem /decisions [keyword]` | ADR-style decision log deduped across all sessions |
| `@mem /savings` | Lifetime token savings and GPT-4o dollar-equivalent |

---

## Enterprise & Azure

### Built for locked-down machines

- No admin install required
- No outbound service dependency
- No native binaries
- No open ports
- Default glob exclusions for `.env*`, `*.pem`, `*.key`, `secrets/**`, and `node_modules/**`
- `<private>...</private>` content never persists
- Data stored per-user in VS Code state plus `~/.ghcp-mem/sessions.json`
- MIT licensed

### Built for Azure shops

- 12-subsystem classifier across `bicep`, Terraform, `azd`, Functions, App Service, AKS, Container Apps, Storage, Key Vault, OpenAI, `az` CLI, and more
- Live `az` snapshot with subscription, tenant, resource group, location, and up to 50 resource IDs
- `@mem /azure` groups Azure-tagged sessions by subsystem
- Azure-aware observation typing and redaction
- Graceful fallback when `az` is missing or not signed in

---

## Commands

| Group | Command | Description |
|---|---|---|
| **Capture** | `GHCP-MEM: Capture Session Snapshot Now` | Manually trigger compression (`⌥⌘M` / `Ctrl+Alt+M`) |
|  | `GHCP-MEM: Compress Current Session` | Compress with progress |
| **Inspect** | `GHCP-MEM: Show Stored Context` | Open a markdown report of sessions |
|  | `GHCP-MEM: Show Memory Health Score` | Show 0-100 health score and notes |
|  | `GHCP-MEM: Run Retrieval Eval` | Compare retrieval quality |
|  | `GHCP-MEM: Open Visual Timeline` | Color-coded WebviewPanel timeline of all sessions |
|  | `GHCP-MEM: Show File Session History` | Sessions that touched the active file (quick-pick) |
| **Backup / Restore** | `GHCP-MEM: Export Memory to JSON...` | Full backup |
|  | `GHCP-MEM: Import Memory from JSON...` | Restore or merge |
|  | `GHCP-MEM: Restore From Backup...` | Restore from rolling backup |
| **Team sharing** | `GHCP-MEM: Export Memory Pack...` | Build a `.ghcpmem-pack.json` |
|  | `GHCP-MEM: Import Memory Pack...` | Install a pack |
|  | `GHCP-MEM: Uninstall Memory Pack...` | Remove imported pack sessions |
| **Sidebar** | `GHCP-MEM: Filter Sessions...` | Filter by scope, type, tag, days, or text |
|  | `GHCP-MEM: Clear Filter` | Reset active filter |
|  | `GHCP-MEM: Refresh` | Refresh sessions tree |
| **Chat** | `GHCP-MEM: Inject Relevant Context Into Copilot Chat...` | Copy top matches into chat |
| **Manage** | `GHCP-MEM: Delete Session` | Delete one session |
|  | `GHCP-MEM: Tag Session...` | Add user tags |
|  | `GHCP-MEM: Pin/Unpin Session` | Pin or unpin a session |
|  | `GHCP-MEM: Open Session Detail` | Open session detail view |
|  | `GHCP-MEM: Export Session as Diff-Friendly Markdown...` | Stable markdown export |
|  | `GHCP-MEM: Clear All Stored Context` | Wipe all stored context |
| **Azure** | `GHCP-MEM: Capture Azure Context Snapshot...` | Save live Azure context |
|  | `GHCP-MEM: Seed Azure Demo Sessions` | Create demo sessions |
| **MCP** | `GHCP-MEM: Show External MCP Client Config` | Show resolved MCP config |

---

## Agent mode tools

Copilot agent mode can call these without a separate MCP setup:

| Tool | Inline reference | What it does |
|---|---|---|
| `ghcpMem_search` | `#ghcpMemSearch <query>` | Search past sessions by keyword, type, date, or tag |
| `ghcpMem_store` | `#ghcpMemStore <note>` | Persist a durable note, decision, or preference |
| `ghcpMem_delete` | — | Delete a session or set of sessions by ID prefix (MCP write) |

---

## `@mem` chat participant

| Command | Example |
|---|---|
| `/status` | `@mem /status` |
| `/recent` | `@mem /recent` |
| `/search` | `@mem /search type:bugfix since:7d authentication` |
| `/timeline` | `@mem /timeline 72h` or `@mem /timeline <id>` |
| `/detail` | `@mem /detail a1b2c3d4` |
| `/export` | `@mem /export a1b2c3d4` |
| `/azure` | `@mem /azure key-vault` |
| `/health` | `@mem /health` |
| `/savings` | `@mem /savings` — token savings breakdown with dollar-equivalent |
| `/related` | `@mem /related` — sessions touching the currently open file |
| `/decisions` | `@mem /decisions` or `@mem /decisions auth` — ADR-style decision log |
| `/standup` | `@mem /standup` or `@mem /standup yesterday` — AI daily standup note |
| `/commit` | `@mem /commit` — AI conventional commit message from staged diff + sessions |
| `/ask` | `@mem /ask why did we change the auth flow?` — RAG Q&A over session history |
| `/recap` | `@mem /recap 7d` / `30d` / `90d` — narrative engineering recap for retros |

---

## Settings

<details>
<summary><b>Configuration reference</b></summary>

| Key | Default | Description |
|---|---|---|
| `ghcpMem.enabled` | `true` | Master switch |
| `ghcpMem.compressionIntervalMinutes` | `15` | Periodic compression |
| `ghcpMem.maxStoredSessions` | `50` | Count-based retention |
| `ghcpMem.maxStoreSizeMB` | `25` | Soft size cap on `~/.ghcp-mem/sessions.json` |
| `ghcpMem.retentionDays` | `90` | Age-based retention |
| `ghcpMem.contextRetrievalCount` | `5` | Number of injected matches |
| `ghcpMem.scope` | `"user"` | Retrieval scope: `user`, `workspace`, or `repo` |
| `ghcpMem.validateAgainstCodebase` | `true` | Drop stale memories whose key files no longer exist |
| `ghcpMem.freshnessFloor` | `0.25` | Minimum surviving key-file fraction |
| `ghcpMem.githubCompatibleMode` | `false` | Mirror Copilot Memory's 28-day repo-scoped contract |
| `ghcpMem.redactSecrets` | `true` | Secret and PII scanning |
| `ghcpMem.honorPrivateTags` | `true` | Strip `<private>...</private>` |
| `ghcpMem.excludeGlobs` | default exclusions | Skip sensitive or noisy paths |
| `ghcpMem.autoInjectStartupContext` | `true` | Write auto-injected instructions file |
| `ghcpMem.healthAlertThreshold` | `30` | Warn when health score is low |
| `ghcpMem.autosave.enabled` | `true` | Enable context-pressure autosave |
| `ghcpMem.autosave.eventThreshold` | `40` | Autosave after buffered event threshold |
| `ghcpMem.autosave.minutesThreshold` | `20` | Autosave after time threshold |
| `ghcpMem.captureFileEdits` | `true` | Capture file edits |
| `ghcpMem.captureDiagnostics` | `true` | Capture diagnostics |
| `ghcpMem.captureTerminalCommands` | `true` | Capture terminal commands |
| `ghcpMem.captureGitOps` | `true` | Capture git operations |

</details>

---

## External MCP clients

GHCP-MEM mirrors memory to `~/.ghcp-mem/sessions.json`. MCP-compatible clients can read it through the bundled stdio server.

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

Use **`GHCP-MEM: Show External MCP Client Config`** to get the resolved path on your machine.

**Exposed MCP tools (6 total):**

- `ghcpMem_search(query, type?, sinceDays?, tag?, workspaceName?, limit?)` — keyword + RRF search
- `ghcpMem_recent(limit?, workspaceName?)` — most recent sessions
- `ghcpMem_timeline(days?, limit?)` — sessions by time window
- `ghcpMem_get(id)` — full session by ID prefix
- `ghcpMem_store(summary, tags?, observationType?)` — write a new session from an external client
- `ghcpMem_delete(id)` — delete a session by ID prefix

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/pipeline.png" alt="GHCP-MEM capture pipeline: events, redaction, compression, storage, and retrieval" width="900">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/ghcp-mem/main/images/diagrams/architecture.png" alt="GHCP-MEM module architecture" width="900">
</p>

Key modules:

| Module | Responsibility |
|---|---|
| `src/redactor.ts` | 24-rule secret and privacy redaction |
| `src/azureDetect.ts` | Azure subsystem detection |
| `src/azureContext.ts` | `az` CLI snapshotting with cache and fallback |
| `src/sessionCapture.ts` | VS Code event hooks and capture pipeline |
| `src/contextCompressor.ts` | LM compression, classification, and git branch tagging |
| `src/contextStore.ts` | Persistent storage, indexing, eviction, backups, lifetime token stats |
| `src/searchCore.ts` | Shared retrieval scoring (BM25 + RRF + recency decay) |
| `src/contextProvider.ts` | `@mem` chat participant with 15 slash commands |
| `src/memoryTool.ts` | Agent-mode tools |
| `src/mcpServer.ts` | Stand-alone stdio MCP server (6 tools, read + write) |
| `src/timelinePanel.ts` | Visual Memory Timeline WebviewPanel |
| `src/sessionCodeLens.ts` | Inline file-history CodeLens at line 0 |
| `src/extension.ts` | Lifecycle, commands, walkthroughs, integration wiring |

More detail: [docs/diagrams/pipeline.mmd](https://github.com/ITcredibl/ghcp-mem/blob/main/docs/diagrams/pipeline.mmd)

---

## Privacy & security

> **All data stays on your machine.** GHCP-MEM does not open a port, phone home, or send your stored memory to a third party.

- **Storage:** VS Code `globalState` plus atomic mirror to `~/.ghcp-mem/sessions.json`
- **LM traffic:** your existing Copilot subscription only
- **Redaction:** dual-pass redaction at capture and LM output time, plus redact-on-import
- **Workspace artifact:** `.github/instructions/session-memory.instructions.md`, automatically added to `.gitignore`
- **Attack surface:** VS Code extension host only

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Memory count stays at zero | Trigger `Capture Session Snapshot Now`, or lower autosave thresholds. |
| `@mem` says no Copilot language model is available | Install and sign in to GitHub Copilot. |
| `/azure` says Azure CLI is not signed in | Run `az login`; GHCP-MEM degrades gracefully if Azure CLI is unavailable. |
| `~/.ghcp-mem/sessions.json` does not exist | It is created on first successful persist. |
| MCP client cannot see tools | Point it to `<extension-install-dir>/out/mcpServer.js` or use the built-in config command. |
| Terminal commands are missing | Enable VS Code shell integration. |
| Tests fail with `Cannot find module 'vscode'` | Run `npm install` first, then `npm test`. |
| You want to wipe everything | Run `Clear All Stored Context`, delete `~/.ghcp-mem/`, and see [docs/UNINSTALL.md](docs/UNINSTALL.md) for a full clean-removal checklist. |

---

## Uninstall

To remove GHCP-MEM completely — extension, stored sessions, workspace artifact, and any MCP/cross-editor injections — follow the step-by-step guide:

**[docs/UNINSTALL.md](docs/UNINSTALL.md)**

Quick summary:
1. *(Optional)* Export your memory: `GHCP-MEM: Export Memory to JSON...`
2. Clear stored data: `GHCP-MEM: Clear All Stored Context`
3. Uninstall the extension: Extensions sidebar → gear → **Uninstall** (or `code --uninstall-extension ITcredibl.ghcp-mem`)
4. Delete `~/.ghcp-mem/` (the MCP mirror file)
5. Remove `.github/instructions/session-memory.instructions.md` from your workspace
6. Remove any cross-editor files (`CLAUDE.md` block / `.cursor/rules/ghcp-mem.md`) if injected

---

## License

MIT — see [LICENSE](https://github.com/ITcredibl/ghcp-mem/blob/main/LICENSE).

---

[Report a bug](https://github.com/ITcredibl/ghcp-mem/issues) · [Request a feature](https://github.com/ITcredibl/ghcp-mem/issues) · [Live demo](docs/DEMO.md) · [Compare memory tools](docs/COMPARISON.md) · [Uninstall guide](docs/UNINSTALL.md) · [Configuration reference](docs/CONFIGURATION.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

<sub>**v1.3.0** · zero native deps · zero ports · local-first memory for Copilot</sub>
