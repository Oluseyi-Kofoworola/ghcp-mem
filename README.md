# 🧠 Baton

### You ship features. Your AI shouldn't have to relearn your project every morning.

> **You're an engineer. You build. You ship. The last thing you want is to spend
> the first 10 minutes of every Copilot chat re-explaining what your project does,
> what you've already decided, and why.**
>
> Baton gives Copilot a local memory that **remembers what you built**, **proves
> what it remembers** (every stored decision cites the captured events that produced it),
> and **routes most "what / why / how" questions to a millisecond-latency local lookup**
> instead of a fresh Copilot completion — so your token budget goes to shipping, not
> catching up.

**Local-first · Copilot chat participant · MCP stdio · Redaction-first**

[![VS Code Extension](https://img.shields.io/badge/VS_Code-1.93+-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-Native-24292e?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-7e3aed?style=for-the-badge)](https://modelcontextprotocol.io/)
[![Azure-aware](https://img.shields.io/badge/Azure-aware-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white)](#enterprise--azure)

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ITcredibl.baton-mem?label=marketplace&color=007ACC&style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem)
[![Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/ITcredibl.baton-mem?label=installs&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem)
[![Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/ITcredibl.baton-mem?label=downloads&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem)
[![Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/ITcredibl.baton-mem?label=rating&color=007ACC&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/ITcredibl/baton-mem/blob/main/LICENSE)
[![Contributing](https://img.shields.io/badge/contributing-guide-orange?style=flat-square)](https://github.com/ITcredibl/baton-mem/blob/main/CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/security-policy-red?style=flat-square)](https://github.com/ITcredibl/baton-mem/blob/main/SECURITY.md)

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem">
    <img src="https://img.shields.io/badge/▶_Install_from_Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install from VS Code Marketplace" height="38">
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/ITcredibl/baton-mem/blob/main/docs/DEMO.md">
    <img src="https://img.shields.io/badge/📺_6--min_Live_Demo-22c55e?style=for-the-badge" alt="Watch the 6-minute live demo" height="38">
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/ITcredibl/baton-mem/blob/main/docs/COMPARISON.md">
    <img src="https://img.shields.io/badge/🔍_Compare_vs_alternatives-7c3aed?style=for-the-badge" alt="Compare against other memory tools" height="38">
  </a>
</p>

---

## The problem you're actually solving

Every new Copilot chat is a fresh amnesia. The cost shows up in three places:

### What it costs you in tokens (external)
- Copilot re-reads files just to figure out *"what is this project?"* — 2,000–10,000 tokens before you've asked a real question.
- You re-explain the same architecture decisions, week after week.
- Even when memory tools "remember" something, you can't audit *why* — so when the AI is subtly wrong, you don't know it.

### What it costs you in flow (internal)
- The first ten minutes of every chat feel like onboarding the same intern, again.
- You start second-guessing AI suggestions because they might be from a memory layer that's hallucinating context you can't verify.
- You stop trusting the tool — and silently revert to copy-paste prompting.

### What it costs the craft (philosophical)
- **AI should remember the work you've already done — and prove what it remembers.** A coding assistant without provenance is a coworker with confident amnesia: the worst kind to work with.

---

## Meet your guide

We built Baton because we hit the same wall: a Copilot that forgot everything, a market full of "memory" tools that wanted ports, sidecars, vector databases, or cloud sync — and not one of them showing receipts for what they claimed to remember.

**Baton is what we shipped instead.** It's the memory layer we wanted: **local-first, evidence-grounded, self-routing.** Built specifically for VS Code + Copilot, then extended to every MCP-compatible agent (Cursor, Cline, Windsurf, Claude Desktop, Copilot CLI) through one stdio server.

**Why we have the right to guide you here:**

- **323 tests, zero native dependencies, zero open ports** — `npm install` doesn't compile anything. Source is formatted with Prettier (CI-enforced) so reviewers see real code, not bundle output. Auditable in an afternoon.
- **Nine documented engineering phases**, each with grounded design rationale in the [CHANGELOG](https://github.com/ITcredibl/baton-mem/blob/main/CHANGELOG.md). No marketing claims that don't have code behind them.
- **An evidence-citation gate in the compressor** — the LM cannot emit a decision without pointing at the captured event that produced it. Hallucinated rationale never reaches storage.
- **An nDCG@K regression gate** runs in CI — if a ranker change regresses retrieval, the build fails.
- **`/compliance` chat command** prints a one-shot audit report (grounding coverage, trust distribution, conflict counts, redaction stats) — built for the security reviewers in your org, not just for engineers.

---

## The plan — 3 steps

| Step | What you do | What Baton does |
|---|---|---|
| **1. Install** | One click from the Marketplace, or `code --install-extension ITcredibl.baton-mem` | Activates on next VS Code launch. Zero config required. |
| **2. Code normally** | Edit files, run terminals, push commits — your usual day | Captures events locally, redacts secrets, compresses sessions through your own Copilot subscription |
| **3. Open a new chat** | Type `@baton` or just ask your usual question | Copilot starts with the prior session's decisions already cited. For "what / why / how" questions, the answer comes from local lookup — *no Copilot completion is spent* — which is where the headline token-cost reduction comes from. The synthetic benchmark estimates 5–20× savings on this query class; results on your real repo will vary with query mix. |

That's it. No daemon to keep running. No cloud account to register. No vector DB to provision.

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem">
    <img src="https://img.shields.io/badge/Step_1_·_Install_from_Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install from Marketplace" height="40">
  </a>
</p>

---

## What you avoid

Without a memory layer that proves itself, the cost compounds session by session:

| If you don't act | What it costs you |
|---|---|
| Catch-up tokens stay invisible | You burn 2,000–10,000 tokens per chat re-explaining what's already in your repo |
| Decisions live only in your head | Three weeks later, you can't remember *why* the auth refactor took the shape it did — and Copilot guesses |
| AI "memory" you can't audit | The model surfaces a confident claim once, you act on it, and only later discover it was wrong — trust is broken |
| Conflicting decisions stack up | "We use JWT" / "We switched to sessions" / "We're back on JWT for mobile" — Copilot sees them all, picks one at random |
| Compliance reviews require a research project | When security asks *what does this tool know about our code?*, you can't answer in under a day |

---

## What success looks like

With Baton, the failure modes above are designed-out:

- 🟢 **Your Copilot resumes where you left off.** The auto-injected memory file makes every new session start with context already loaded.
- 🟢 **Every decision is cited.** `@baton /entity src/auth.ts` shows you the supersession chain, the evidence, the contributors — in 500 tokens.
- 🟢 **Wrong rank? You see why.** `@baton /why <q> :: <id>` breaks down every signal that contributed to a ranking — when the system is wrong, it tells you exactly why.
- 🟢 **Contradictions surface before they bite.** `/conflicts` flags "we picked X *instead of* Y" decisions that overlap with older choices.
- 🟢 **Token bill goes down.** The startup primer biases Copilot toward MCP queries (~200–500 tokens) over file opens (~2,000–10,000 tokens) for history questions. 5–20× cheaper from message one.
- 🟢 **Security review takes 5 minutes.** `/compliance` prints the audit report. You hand it to the reviewer and move on.

**Tokens go to building. Decisions stay grounded. Trust holds.**

---

## How it surfaces (4 pillars at a glance)

| Pillar | What it delivers | Try it |
|---|---|---|
| **🧠 Memory** | Persistent, structured record of what you changed, decided, fixed, deployed — captured locally from real editor events | `@baton /recent` · `@baton /entity src/<file>` |
| **💰 Tokens** | Auto-routing primer in every Copilot session steers the agent to cheap MCP queries over file opens | `@baton /route <question>` shows the cost estimate |
| **⚡ Performance** | Hybrid retrieval — BM25 + recency + embeddings + match-ratio + decayed confidence + reinforcement, tuned by per-user adaptive weights, gated by nDCG@K regression suite | `@baton /why <q> :: <id>` decomposes the score |
| **🤖 AI agentic coding** | Full MCP parity (13 tools), evidence-grounded decisions, conflict detection, score explainer, Mermaid graph export — for Cursor, Cline, Windsurf, Claude Desktop, Copilot CLI | `npx baton-mem-mcp` exposes all tools over stdio |

It surfaces memory through:

- the **`@baton`** chat participant (34 commands including `/savings`, `/entity`, `/snippet`, `/why`, `/graph`, `/compliance`, `/route`)
- native Copilot **agent tools** (`#batonSearch`, `#batonStore`, `#batonAudit`)
- a bundled **stdio MCP server** with 13 tools for Cursor, Cline, Windsurf, Claude Desktop, and GitHub Copilot CLI

### Why engineers trust it (deeper guarantees)

| What Baton does | Why it matters |
|---|---|
| **Auto-routes Copilot to cheap context** | Every new session ships a routing primer that biases the agent toward MCP queries (~200–500 tokens) over file opens (~2,000–10,000 tokens) for "why / what / how" questions |
| **Grounds every decision in evidence** | The compressor enforces an evidence-citation gate: any decision the LM emits without pointing at a captured event is dropped before storage. No hallucinated "we picked X because Y" |
| **Scores trust per memory + decays over time** | Each session carries a `confidence ∈ [0, 1]` derived from evidence breadth, redaction noise, and compressor mode; effective confidence decays with disuse (60-day half-life) so stale memories fade in ranking |
| **Detects contradictions on capture** | Heuristic conflict detector flags decisions containing markers like "instead of" / "deprecated" that overlap with older sessions sharing files; surfaces via `/conflicts` for review |
| **Explains every rank** | `/why <query> :: <id>` returns a per-signal score breakdown (keyword, recency, confidence, feedback, learned weights, …) so when ranking is wrong, you can see why |
| **Learns from your feedback** | `/accept` and `/reject` pump signals into a bounded adaptive learner (±25% per weight, 60-day half-life) so the ranker tunes to your actual workflow |
| **Runs with zero native dependencies** | No Bun, Python, SQLite binary, WASM, Chroma, or model downloads |
| **Opens zero network ports** | No Baton backend or telemetry. LM compression uses your existing Copilot subscription only |
| **Stores data locally** | Memory stays on your machine under your control |
| **Redacts secrets by default** | 26-rule dual-pass redaction + custom regex rules + custom-entity literal rules + `<private>...</private>` stripping |
| **Enterprise privacy controls** | Strict mode disables terminal capture, raw snippets, team export, and MCP write tools |
| **Supports enterprise policy injection** | Optional remote policy URL appends centrally managed redaction rules on startup |
| **Idle-triggered compression** | Auto-flush sessions when editor is inactive (configurable 0–300s timeout) |
| **Enterprise compliance modes** | User-defined regex redaction rules for FinTech (PCI-DSS), Healthcare (HIPAA), or custom compliance, plus `customSensitiveEntities` for organisation/project codenames |
| **One-shot compliance posture** | `/compliance` chat command (and `baton_compliance` MCP tool) renders an audit-friendly snapshot: grounding coverage, trust distribution, conflict counts, redaction stats |
| **Understands Azure workflows** | Azure subsystem tagging, live `az` snapshotting, Azure-specific redaction |

---

## How it works

### Step 1: Install it

> **Live on the VS Code Marketplace** — one-click install, auto-updates included.

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem">
    <img src="https://img.shields.io/badge/Install_from_Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install from VS Code Marketplace" height="36">
  </a>
  &nbsp;
  <a href="vscode:extension/ITcredibl.baton-mem">
    <img src="https://img.shields.io/badge/Open_in_VS_Code-22c55e?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Open in VS Code" height="36">
  </a>
</p>

| Method | Steps |
|---|---|
| **Marketplace (recommended)** | Install from the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=ITcredibl.baton-mem). |
| **Inside VS Code** | Open Extensions (`⇧⌘X` / `Ctrl+Shift+X`), search **Baton**, click **Install**. |
| **Command line** | `code --install-extension ITcredibl.baton-mem` |
| **Offline / air-gapped** | Download a [`.vsix` from Releases](https://github.com/ITcredibl/baton-mem/releases) and run `code --install-extension baton-mem-<version>.vsix` |

#### Verify the installed extension (security-conscious teams)

Every release from **v1.6.1 onward** uploads four artifacts to its [GitHub Release](https://github.com/ITcredibl/baton-mem/releases) page:

| Artifact | What it lets you check |
|---|---|
| `baton-mem.vsix` | The exact build the Marketplace publishes |
| `baton-mem.vsix.sha256` | Tamper-evident integrity for the `.vsix` |
| `sbom.json` (CycloneDX) | Every npm dependency that ends up in the bundle — auditable before install |
| `release-manifest.json` + SLSA L3 provenance attestation | Build provenance: this `.vsix` was built by the public `release.yml` workflow on the matching tag |

> **Backfilled v1.5.0–v1.6.0 releases** include `.vsix` + `.sha256` + `sbom.json` + a manifest, but **not** the SLSA L3 attestation — those tags predate the workflow fix that lets the attestor run successfully. Verify them via the SHA-256 + SBOM only. v1.6.1+ has the full L3 trail.

End-to-end verification script you can paste into a terminal:

```bash
# Discover the installed version and the matching tag.
VERSION=$(code --list-extensions --show-versions | grep -i 'ITcredibl.baton-mem' | cut -d@ -f2)
TAG="v${VERSION}"
test -n "$VERSION" || { echo "Baton not installed"; exit 1; }

# 1. Pull the public release artifacts.
BASE="https://github.com/ITcredibl/baton-mem/releases/download/${TAG}"
curl -sfLO "${BASE}/baton-mem.vsix"            || { echo "no .vsix for ${TAG}"; exit 1; }
curl -sfLO "${BASE}/baton-mem.vsix.sha256"     || { echo "no checksum for ${TAG}"; exit 1; }
curl -sfLO "${BASE}/sbom.json"                || echo "(no SBOM for ${TAG} — backfilled release)"

# 2. Verify the .vsix matches its published checksum.
shasum -a 256 -c baton-mem.vsix.sha256

# 3. Verify your locally-installed bundle byte-for-byte against the .vsix.
EXT_DIR="$HOME/.vscode/extensions/itcredibl.baton-mem-${VERSION}"
test -d "$EXT_DIR" || { echo "expected $EXT_DIR — is the extension installed?"; exit 1; }
unzip -p baton-mem.vsix 'extension/out/extension.js' \
  | shasum -a 256 \
  | awk '{print $1}' > /tmp/release-extension.sha256
shasum -a 256 "$EXT_DIR/out/extension.js" \
  | awk '{print $1}' > /tmp/installed-extension.sha256
diff /tmp/release-extension.sha256 /tmp/installed-extension.sha256 \
  && echo "✅ installed bundle SHA matches the public release"

# 4. (v1.6.1+ only) Verify the SLSA L3 provenance attestation.
gh attestation verify baton-mem.vsix --owner ITcredibl
```

Step 3 catches the only attack that step 2 can't: a tampered Marketplace artifact that wasn't built from the public source. If step 3's `diff` shows a mismatch on a v1.6.1+ install, **don't trust the install** — open an issue with the diff and the installed-extension manifest.

### Step 2: Let it capture your work

Baton records the signals that matter in a coding session:

- file edits, creates, deletes, renames, opens, closes
- diagnostics transitions
- git changes
- debug session start and stop
- task runs with exit codes
- terminal commands through VS Code shell integration

Then it debounces, redacts, classifies, and compresses those events into structured memory.

### Step 3: Ask for the right memory at the right time

Use:

- `@baton /recent`
- `@baton /search`
- `@baton /timeline`
- `@baton /detail`
- `#batonSearch`
- `#batonStore`

Or connect the bundled MCP server from clients like Cursor, Cline, Windsurf, Claude Desktop, or GitHub Copilot CLI.

---

## Get started

Stop burning tokens on catch-up. Install Baton and capture your first snapshot:

1. Install **Baton**
2. Open any workspace
3. Run **`Baton: Capture Session Snapshot Now`**
4. Open Copilot Chat and try **`@baton /recent`**
5. Run **`@baton /savings`** after a few sessions to see session-by-session and lifetime token-savings _estimates_

<details>
<summary><b>📺 Watch the install in 5 seconds</b></summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/baton-mem/main/images/demo/install-animation.gif" alt="Animated terminal: code --install-extension ITcredibl.baton-mem then installed successfully" width="720">
</p>

</details>

---

## Who it is built for

Baton is the local, auditable session-memory layer for engineers who live in VS Code, use Copilot, work in Azure-heavy enterprise environments, and cannot run cloud memory services, sidecars, local HTTP workers, or native dependencies.

If your machine is locked down, air-gapped, or subject to data residency rules, Baton is designed for your constraints — not around them.

---

## Why teams need this

Without persistent session memory, every session charges the same hidden tax:

- tokens burned re-explaining what the project does
- tokens burned re-establishing architecture and patterns
- tokens burned re-learning why a decision was made
- more tokens spent on the same work, slower progress, worse answers

Baton eliminates that tax. **The tokens you stop wasting on catch-up are the tokens that get your work done.**

---

## See it in action

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/baton-mem/main/images/demo/pipeline-animation.gif" alt="Animated Baton pipeline: edits flow through redaction and compression, then return as recalled memory in chat" width="900">
</p>

**What happens:** every edit, diagnostic, git op, and terminal command is debounced, scrubbed of secrets, summarized through your existing Copilot LM, and stored locally. Later, Baton recalls the most relevant prior context in milliseconds.

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

Baton classifies sessions into:

`feature` · `bugfix` · `refactor` · `docs` · `test` · `chore` · `research` · `config` · `security` · `deployment` · `infra` · `unknown`

Azure signals such as `azd`, `az`, `.bicep`, and `.tf` edits influence `deployment` and `infra` inference automatically.

### Secret redaction

**18 generic patterns** including:

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
  <img src="https://raw.githubusercontent.com/ITcredibl/baton-mem/main/images/diagrams/retrieval.png" alt="Hybrid retrieval with keyword, recency, embeddings, and rank fusion" width="800">
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

**`Baton: Open Visual Timeline`** (Command Palette) opens a full WebviewPanel timeline — color-coded by observation type, searchable by keyword or branch, with expandable session cards.

### Session CodeLens

A `📚 N sessions touched this file` lens appears at the top of every opened source file. Click it to open a quick-pick of sessions that edited the same path, pre-sorted by recency.

### AI-powered chat commands

| Command | What it generates |
|---|---|
| `@baton /standup` | Daily standup note from yesterday's sessions |
| `@baton /commit` | Conventional commit message from staged diff + recent sessions |
| `@baton /ask <question>` | Cited answer pulled from matching sessions via RAG |
| `@baton /recap [7d\|30d\|90d]` | Narrative engineering recap for sprint retros |
| `@baton /related` | Sessions that touched the active file, grouped by recency |
| `@baton /decisions [keyword]` | ADR-style decision log deduped across all sessions |
| `@baton /savings` | Session and lifetime token-savings _estimates_ plus GPT-4o dollar-equivalent |
| `@baton /whereami` | Interruption-recovery brief: what you were doing, where you left off, your next step |
| `@baton /debt` | Technical debt ledger — TODO/FIXME/HACK signals grouped by age and file |
| `@baton /adr [topic]` | Formal Architecture Decision Record auto-generated from session history |
| `@baton /pr [branch\|PR#]` | PR review context — surface sessions matching the PR's changed files |
| `@baton /precommit` | Pre-commit check — verify staged changes against past architectural decisions |

### Trust + lineage commands (added in 1.6.0)

| Command | What it does |
|---|---|
| `@baton /entity <path>[#symbol]` | Aggregate every session that touched a file or LSP symbol — decisions, problems, topics, supersession lineage, recent sessions |
| `@baton /snippet <query>` | Chunk-level retrieval — returns the exact decision/problem text matching the query (not whole sessions) |
| `@baton /conflicts` / `/conflicts dismiss <id>` | List or dismiss pending heuristic conflict warnings (e.g. "use JWT *instead of* cookies" overlapping with an older cookie-session decision) |
| `@baton /lineage <id>` | Cross-session causal chain — predecessors and successors sharing files within ±30 days, edge-labeled (`introduced_issue_fixed_by`, etc.) |
| `@baton /verify <id>` | Re-run SHA-based grounding validation — per-file `verified` / `drifted` / `missing` breakdown |
| `@baton /correct <id> <text>` | Capture a correction note that supersedes the original session (kept in the audit log) |
| `@baton /supersede <newer> <older>` | Mark one session as superseding another; auto-acknowledges matching conflict warnings |
| `@baton /retract <id> [reason]` / `/retract undo <id>` | Exclude a session from retrieval/injection (reversible) |
| `@baton /accept <id>` / `/reject <id>` | Reinforcement signal — strengthens or weakens a session's retrieval ranking |
| `@baton /why <query> :: <id>` | Score-decomposition explainer — break down every signal contribution (keyword, recency, confidence, feedback, …) |
| `@baton /graph [file:<path>]` | Mermaid flowchart of the decision graph (supersession + correction + causal edges) for paste into PRs/ADRs |
| `@baton /compliance` | One-shot audit report: grounding coverage, trust distribution, conflict counts, redaction stats |

---

## Enterprise & Azure

### Built for locked-down machines

- No admin install required
- No outbound service dependency
- No native binaries
- No open ports
- Default glob exclusions for `.env*`, `*.pem`, `*.key`, `secrets/**`, and `node_modules/**`
- `<private>...</private>` content never persists
- Data stored per-user in VS Code state plus `~/.baton-mem/sessions.json`
- MIT licensed

### Built for Azure shops

- 12-subsystem classifier across `bicep`, Terraform, `azd`, Functions, App Service, AKS, Container Apps, Storage, Key Vault, OpenAI, `az` CLI, and more
- Live `az` snapshot with subscription, tenant, resource group, location, and up to 50 resource IDs
- `@baton /azure` groups Azure-tagged sessions by subsystem
- Azure-aware observation typing and redaction
- Graceful fallback when `az` is missing or not signed in

---

## Commands

| Group | Command | Description |
|---|---|---|
| **Capture** | `Baton: Capture Session Snapshot Now` | Manually trigger compression (`⌘⇧⌥S` / `Ctrl+Shift+Alt+S`) |
|  | `Baton: Compress Current Session` | Compress with progress |
| **Inspect** | `Baton: Show Stored Context` | Open a markdown report of sessions |
|  | `Baton: Show Memory Health Score` | Show 0-100 health score and notes |
|  | `Baton: Run Retrieval Eval` | Compare retrieval quality |
|  | `Baton: Open Visual Timeline` | Color-coded WebviewPanel timeline of all sessions |
|  | `Baton: Show File Session History` | Sessions that touched the active file (quick-pick) |
| **Backup / Restore** | `Baton: Export Memory to JSON...` | Full backup |
|  | `Baton: Import Memory from JSON...` | Restore or merge |
|  | `Baton: Restore From Backup...` | Restore from rolling backup |
| **Team sharing** | `Baton: Export Memory Pack...` | Build a `.ghcpmem-pack.json` |
|  | `Baton: Import Memory Pack...` | Install a pack |
|  | `Baton: Uninstall Memory Pack...` | Remove imported pack sessions |
|  | `Baton: Export Team Memory Snapshot` | Write `.github/memory/team-context.md` for git-native team context sharing |
| **Sidebar** | `Baton: Filter Sessions...` | Filter by scope, type, tag, days, or text |
|  | `Baton: Clear Filter` | Reset active filter |
|  | `Baton: Refresh` | Refresh sessions tree |
| **Chat** | `Baton: Inject Relevant Context Into Copilot Chat...` | Copy top matches into chat |
| **Manage** | `Baton: Delete Session` | Delete one session |
|  | `Baton: Tag Session...` | Add user tags |
|  | `Baton: Pin/Unpin Session` | Pin or unpin a session |
|  | `Baton: Open Session Detail` | Open session detail view |
|  | `Baton: Export Session as Diff-Friendly Markdown...` | Stable markdown export |
|  | `Baton: Clear All Stored Context` | Wipe all stored context |
| **Azure** | `Baton: Capture Azure Context Snapshot...` | Save live Azure context |
|  | `Baton: Seed Azure Demo Sessions` | Create demo sessions |
| **MCP** | `Baton: Show External MCP Client Config` | Show resolved MCP config |

---

## Agent mode tools

Copilot agent mode can call these without a separate MCP setup:

| Tool | Inline reference | What it does |
|---|---|---|
| `baton_search` | `#batonSearch <query>` | Search past sessions by keyword, type, date, or tag |
| `baton_store` | `#batonStore <note>` | Persist a durable note, decision, or preference |

---

## `@baton` chat participant

| Command | Example |
|---|---|
| `/status` | `@baton /status` |
| `/recent` | `@baton /recent` |
| `/search` | `@baton /search type:bugfix since:7d authentication` |
| `/timeline` | `@baton /timeline 72h` or `@baton /timeline <id>` |
| `/detail` | `@baton /detail a1b2c3d4` |
| `/export` | `@baton /export a1b2c3d4` |
| `/azure` | `@baton /azure key-vault` |
| `/health` | `@baton /health` |
| `/savings` | `@baton /savings` — per-session and lifetime token-savings _estimates_ with dollar-equivalent. Note: estimates derived from typical Copilot context windows, not measured against real Copilot sessions |
| `/related` | `@baton /related` — sessions touching the currently open file |
| `/decisions` | `@baton /decisions` or `@baton /decisions auth` — ADR-style decision log |
| `/standup` | `@baton /standup` or `@baton /standup yesterday` — AI daily standup note |
| `/commit` | `@baton /commit` — AI conventional commit message from staged diff + sessions |
| `/ask` | `@baton /ask why did we change the auth flow?` — RAG Q&A over session history |
| `/recap` | `@baton /recap 7d` / `30d` / `90d` — narrative engineering recap for retros |
| `/whereami` | `@baton /whereami` — interruption recovery brief with AI re-entry suggestion |
| `/debt` | `@baton /debt` — technical debt ledger from session signals, grouped by age |
| `/adr` | `@baton /adr auth` — formal ADR auto-generated from session history |
| `/pr` | `@baton /pr main` or `@baton /pr 42` — PR review context from session history |
| `/precommit` | `@baton /precommit` — pre-commit architectural consistency check |

---

## Settings

<details>
<summary><b>Configuration reference</b></summary>

| Key | Default | Description |
|---|---|---|
| `baton.enabled` | `true` | Master switch |
| `baton.compressionIntervalMinutes` | `15` | Periodic compression |
| `baton.maxStoredSessions` | `50` | Count-based retention |
| `baton.maxStoreSizeMB` | `25` | Soft size cap on `~/.baton-mem/sessions.json` |
| `baton.retentionDays` | `90` | Age-based retention |
| `baton.contextRetrievalCount` | `5` | Number of injected matches |
| `baton.scope` | `"user"` | Retrieval scope: `user`, `workspace`, or `repo` |
| `baton.validateAgainstCodebase` | `true` | Drop stale memories whose key files no longer exist |
| `baton.freshnessFloor` | `0.25` | Minimum surviving key-file fraction |
| `baton.githubCompatibleMode` | `false` | Mirror Copilot Memory's 28-day repo-scoped contract |
| `baton.redactSecrets` | `true` | Secret and PII scanning |
| `baton.honorPrivateTags` | `true` | Strip `<private>...</private>` |
| `baton.excludeGlobs` | default exclusions | Skip sensitive or noisy paths |
| `baton.autoInjectStartupContext` | `true` | Write prior session context to `.github/instructions/session-memory.instructions.md`, `CLAUDE.md`, and `.cursor/rules` on startup and after each compression |
| `baton.startupContextSessionCount` | `5` | Number of recent sessions (1–20) included in the auto-injected instructions file |
| `baton.healthAlertThreshold` | `30` | Warn when health score is low |
| `baton.autosave.enabled` | `true` | Enable context-pressure autosave |
| `baton.autosave.eventThreshold` | `40` | Autosave after buffered event threshold |
| `baton.autosave.minutesThreshold` | `20` | Autosave after time threshold |
| `baton.captureFileEdits` | `true` | Capture file edits |
| `baton.captureDiagnostics` | `true` | Capture diagnostics |
| `baton.captureTerminalCommands` | `true` | Capture terminal commands |
| `baton.captureDiagnostics` | `true` | Capture error/warning diagnostics |
| `baton.captureGitOps` | `true` | Capture git operations |
| `baton.redactSecrets` | `true` | Redact secrets and PII |
| `baton.idleTimeoutSeconds` | `30` | Seconds of inactivity before idle-triggered compression (0 = disabled) |
| `baton.customRedactionRules` | `[]` | Array of custom regex redaction rules for enterprise compliance modes |
| `baton.captureGitOps` | `true` | Capture git operations |

</details>

---

## External MCP clients

Baton mirrors memory to `~/.baton-mem/sessions.json`. MCP-compatible clients can read it through the bundled stdio server.

```json
{
  "mcpServers": {
    "baton-mem": {
      "command": "node",
      "args": ["/path/to/extension/out/mcpServer.js"]
    }
  }
}
```

Use **`Baton: Show External MCP Client Config`** to get the resolved path on your machine.

**Exposed MCP tools (6 total):**

- `baton_search(query, type?, sinceDays?, tag?, workspaceName?, limit?)` — keyword + RRF search
- `baton_recent(limit?, workspaceName?)` — most recent sessions
- `baton_timeline(days?, limit?)` — sessions by time window
- `baton_get(id)` — full session by ID prefix
- `baton_store(summary, tags?, observationType?)` — write a new session from an external client
- `baton_delete(id)` — delete a session by ID prefix

---

## CI/CD Integration: Memory Seeding

Baton ships a headless CLI seeder for pre-populating memory from CI/CD pipelines. When a developer checks out a feature branch, the pipeline can generate a condensed summary of recent production alerts, infrastructure changes, or staging test results, and pre-seed the local store.

The next time they open VS Code, their AI assistant already has live-environment context without the developer having to ask.

### Usage

```bash
# Seed from a JSON payload
echo '{"sessions": [{"summary": "Prod API at 50% error rate", "observationType": "bugfix", "keyTopics": ["api", "reliability"]}]}' | \
  npx baton-mem-ci-seed

# Or via npm
npm install --save-dev @baton-mem/cli
echo '...' | npx baton-mem-ci-seed --seed-label=prod-alert
```

### Payload format

```jsonc
{
  "sessions": [
    {
      "id": "optional-uuid",
      "summary": "What happened",
      "observationType": "deployment|bugfix|feature|etc",
      "keyTopics": ["tag1", "tag2"],
      "keyFiles": ["path/to/file1.ts"],
      "decisions": ["ADR-style decision"],
      "problemsSolved": ["What we fixed"]
    }
  ],
  "observations": ["Free-form observation text"],
  "seedLabel": "prod-alert"  // tagged for easy filtering later
}
```

All secrets are automatically redacted using the 26-rule set + any custom rules defined in settings.

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/baton-mem/main/images/diagrams/pipeline.png" alt="Baton capture pipeline: events, redaction, compression, storage, and retrieval" width="900">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ITcredibl/baton-mem/main/images/diagrams/architecture.png" alt="Baton module architecture" width="900">
</p>

Key modules:

| Module | Responsibility |
|---|---|
| `src/redactor.ts` | 26-rule secret and privacy redaction + user-defined regex rules |
| `src/ciSeeder.ts` | Headless CLI for pre-seeding memory from CI/CD pipelines (reads JSON from stdin) |
| `src/azureDetect.ts` | Azure subsystem detection |
| `src/azureContext.ts` | `az` CLI snapshotting with cache and fallback |
| `src/sessionCapture.ts` | VS Code event hooks and capture pipeline |
| `src/contextCompressor.ts` | LM compression, classification, and git branch tagging |
| `src/contextStore.ts` | Persistent storage, indexing, eviction, backups, lifetime token stats |
| `src/searchCore.ts` | Shared retrieval scoring (BM25 + RRF + recency decay) |
| `src/contextProvider.ts` | `@baton` chat participant with 20 slash commands |
| `src/memoryTool.ts` | Agent-mode tools |
| `src/mcpServer.ts` | Stand-alone stdio MCP server (6 tools, read + write) |
| `src/timelinePanel.ts` | Visual Memory Timeline WebviewPanel |
| `src/sessionCodeLens.ts` | Inline file-history CodeLens at line 0 |
| `src/extension.ts` | Lifecycle, commands, walkthroughs, integration wiring |

More detail: [docs/diagrams/pipeline.mmd](https://github.com/ITcredibl/baton-mem/blob/main/docs/diagrams/pipeline.mmd)

---

## Privacy & security

> **All Baton data stays on your machine.** Baton has no backend, opens no ports, and sends no telemetry to any third party.
>
> Note: LM compression uses `vscode.lm` — your existing GitHub Copilot subscription — meaning compressed session summaries pass through Copilot's LM. No Baton service is involved.

- **Storage:** VS Code `globalState` plus atomic mirror to `~/.baton-mem/sessions.json`
- **LM traffic:** your existing Copilot subscription only
- **Redaction:** dual-pass redaction at capture and LM output time, plus redact-on-import
- **Workspace artifact:** `.github/instructions/session-memory.instructions.md`, automatically added to `.gitignore`
- **Attack surface:** VS Code extension host only

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Memory count stays at zero | Trigger `Capture Session Snapshot Now`, or lower autosave thresholds. |
| `@baton` says no Copilot language model is available | Install and sign in to GitHub Copilot. |
| `/azure` says Azure CLI is not signed in | Run `az login`; Baton degrades gracefully if Azure CLI is unavailable. |
| `~/.baton-mem/sessions.json` does not exist | It is created on first successful persist. |
| MCP client cannot see tools | Point it to `<extension-install-dir>/out/mcpServer.js` or use the built-in config command. |
| Terminal commands are missing | Enable VS Code shell integration. |
| Tests fail with `Cannot find module 'vscode'` | Run `npm install` first, then `npm test`. |
| You want to wipe everything | Run `Clear All Stored Context`, delete `~/.baton-mem/`, and see [docs/UNINSTALL.md](https://github.com/ITcredibl/baton-mem/blob/main/docs/UNINSTALL.md) for a full clean-removal checklist. |

---

## Uninstall

To remove Baton completely — extension, stored sessions, workspace artifact, and any MCP/cross-editor injections — follow the step-by-step guide:

**[docs/UNINSTALL.md](https://github.com/ITcredibl/baton-mem/blob/main/docs/UNINSTALL.md)**

Quick summary:
1. *(Optional)* Export your memory: `Baton: Export Memory to JSON...`
2. Clear stored data: `Baton: Clear All Stored Context`
3. Uninstall the extension: Extensions sidebar → gear → **Uninstall** (or `code --uninstall-extension ITcredibl.baton-mem`)
4. Delete `~/.baton-mem/` (the MCP mirror file)
5. Remove `.github/instructions/session-memory.instructions.md` from your workspace
6. Remove any cross-editor files (`CLAUDE.md` block / `.cursor/rules`) if injected

---

## License

MIT — see [LICENSE](https://github.com/ITcredibl/baton-mem/blob/main/LICENSE).

---

[Report a bug](https://github.com/ITcredibl/baton-mem/issues) · [Request a feature](https://github.com/ITcredibl/baton-mem/issues) · [Live demo](https://github.com/ITcredibl/baton-mem/blob/main/docs/DEMO.md) · [Compare memory tools](https://github.com/ITcredibl/baton-mem/blob/main/docs/COMPARISON.md) · [Uninstall guide](https://github.com/ITcredibl/baton-mem/blob/main/docs/UNINSTALL.md) · [Configuration reference](https://github.com/ITcredibl/baton-mem/blob/main/docs/CONFIGURATION.md) · [Contributing](https://github.com/ITcredibl/baton-mem/blob/main/CONTRIBUTING.md) · [Security policy](https://github.com/ITcredibl/baton-mem/blob/main/SECURITY.md)

<sub>**v2.0.0** · local-first memory for Copilot</sub>
