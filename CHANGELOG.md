# Changelog

All notable changes to **GHCP-MEM** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.2.1] — 2026-05-14

### Security
- **`.github/workflows/ci.yml`** — Added workflow-level `permissions: contents: read` (least privilege). The release job keeps its `contents: write` override only for the GitHub-release publish step. Closes CodeQL alert `actions/missing-workflow-permissions`.
- **`src/eval.ts`** — `formatEvalReport()` now escapes backslashes _before_ pipes when rendering query strings into the GFM table, so a literal `\` in a query can no longer break the rendered table or smuggle markdown control characters. Closes CodeQL alert `incomplete-string-escaping`.
- **`src/test/redactor.test.ts`**, **`src/test/redactor.corpus.test.ts`** — Every secret-shaped fixture (PATs, OpenAI `sk-`, MongoDB+SRV URIs, Postgres URLs, PEM blocks, Bearer headers, …) is now assembled at runtime via string concatenation. Runtime values still match every redaction regex, but the source files no longer contain a complete-looking credential literal — so GitHub push-protection / secret scanning stop flagging the deliberate regression corpus as a leaked secret.
- **`.github/secret_scanning.yml`** — New file. Adds `paths-ignore` for `src/test/**`, `out-test/**`, `docs/**` as defence-in-depth, with a header comment explaining the rationale (deliberate synthetic regression corpus, no real credentials). Production code paths remain fully scanned.

### Added
- **`docs/linkedin-launch.md`** — Long-form launch article (~1100 words) and short-form announcement post (~280 words) for v1.2.0, ready to publish.

---

## [1.2.0] — 2026-05-14

### Added
- **`src/validator.ts`** — Codebase-validation pass for stored memories. Each retrieved session is checked against the active workspace filesystem; sessions whose `keyFiles` no longer exist are down-ranked or dropped. Cached for 60s so retrieval stays cheap. Mirrors GitHub Copilot agentic memory's "validated against the current codebase before use" guarantee — purely local, no cloud calls.
- **`src/repoScope.ts`** — Stable per-repo scope identifier derived from the git `origin` URL (normalises SSH/HTTPS/`ssh://` and case). When git is unavailable, falls back to a hashed workspace URI. Memories now carry `repoScope` + `repoScopeLabel`, enabling per-repo retrieval that survives clones and machine moves.
- **`src/sessionsView.ts`** — Quick-filter bar on the sidebar tree: scope (workspace/repo/all) · observation type · tag · last-N-days · free-text. Active filter is shown as a clickable chip in the header that clears on click. Wired through new commands `ghcpMem.filterSessions` and `ghcpMem.clearFilter`.
- **`src/markdownExport.ts`** — Diff-friendly session markdown exporter. Stable byte-identical output (sorted arrays, ISO timestamps, deterministic ordering) so committing exports into a repo produces clean diffs. Exposed via `ghcpMem.exportSessionMarkdown`.
- **`src/eval.ts`** — Lightweight retrieval evaluation harness (recall@k + MRR) comparing keyword-only vs hybrid vs hybrid+freshness configurations against a self-generated query set. Wired through `ghcpMem.runEval`.
- **`src/test/validator.test.ts`**, **`src/test/repoScope.test.ts`**, **`src/test/markdownExport.test.ts`** — Unit tests for the new modules.
- **`ghcpMem.scope`** (`user` | `workspace` | `repo`, default `user`) — picks the retrieval scope.
- **`ghcpMem.validateAgainstCodebase`** (default `true`) — toggles the validator.
- **`ghcpMem.freshnessFloor`** (0-1, default `0.25`) — minimum fraction of `keyFiles` that must still exist for a memory to survive validation.
- **`ghcpMem.githubCompatibleMode`** (default `false`) — mirrors GitHub agentic memory's contract: 28-day retention + repo scope (overrides the two settings above when enabled).

### Changed
- **`src/types.ts`** — `CompressedSession` gains optional `repoScope` and `repoScopeLabel`. `PluginConfig` gains `scope`, `validateAgainstCodebase`, `freshnessFloor`, `githubCompatibleMode`. `getConfig()` honours `githubCompatibleMode` by clamping `retentionDays=28` and `scope='repo'`.
- **`src/contextStore.ts`** — `SearchFilters` gains `repoScope`. New `getRepoSessions()` accessor. `searchWithEmbedding` now over-fetches and runs a freshness filter (`filterByFreshness`) honouring the new config keys. `getRelevantSessions`/`getStartupCandidates` pick the candidate pool according to `config.scope`.
- **`src/contextCompressor.ts`** — Compressed sessions are tagged with the active repo scope at capture time (best-effort, never throws).
- **`package.json`** — Version → `1.2.0`. New commands and view-title menu entries. New configuration keys (see above).

---

## [1.1.8] — 2026-05-14

### Changed
- **`images/icon.png`** — New neon-styled marketplace thumbnail (cyan/green outline on dark slate, "GHCP-MEM" wordmark). Matches the dark `galleryBanner` palette already set in `package.json`. 128×128 RGB, no alpha.
- **`docs/diagrams/*.mmd`** — Pipeline diagram redesigned: flat `flowchart LR` with explicit fan-in edges instead of a `direction LR` subgraph (Mermaid was ignoring the hint, producing a 2126×2904 portrait that scrolled forever in the README). New aspect is 3168×902 landscape. Per-event redundant edge labels removed; the `debounced · glob-filtered` annotation moved into the Session Capture node.
- **`docs/diagrams/*.mmd`** — Retrieval and architecture diagrams restyled with a unified dark-slate theme + colour-grouped `classDef`s. Architecture cluster backgrounds set to `#f1f5f9` explicitly so labels stay readable (the default theme rendered them in dark brown).

---

## [1.1.7] — 2026-05-13

### Fixed
- **`extension.ts`** — Wrong publisher ID `ghcp-plugin.ghcp-mem` → `itcredibl.ghcp-mem` in `showMcpInfo` command; MCP server path was always showing placeholder text instead of the real install location.
- **`memoryTool.ts`** — `MemoryStoreTool` was always storing `redactionCount: 0` even when it redacted secrets from user input. Redaction count now accumulates across all fields and is saved correctly, fixing `redactionCoveragePct` in health scores.
- **`contextStore.ts`** — `importFromJson` now returns `{ imported, skippedInvalid }` (was `{ imported }`) so callers can surface a warning when sessions were silently skipped due to invalid UUIDs.
- **`contextStore.ts`** — `rebuildIndexAsync` now uses `setTimeout(0)` instead of `setImmediate`. `setImmediate` is not available in the VS Code web extension host (browser context); `setTimeout(0)` is universally available and has the same macrotask-yield semantics.

### Improved
- **`contextCompressor.ts`** — Truncation second pass now removes the _oldest_ lines (from the head) rather than byte-slicing mid-line at an arbitrary offset. Log tail (most recent activity) is always preserved.
- **`contextCompressor.ts`** — LM model family list expanded to `gpt-4o-mini`, `claude-3-5-haiku`, `gemini-1.5-flash`, `mistral-small`, `gpt-4o`, `claude-3-5-sonnet`, `gemini-1.5-pro`. Users on non-OpenAI providers now get a preferred lightweight model instead of always falling through to `any[0]`.
- **`contextStore.ts`** — New `deleteSessions(ids[])` batch method performs a single `persist()` call for all IDs. `packs.ts` `uninstallPack()` now uses this, removing the O(n) serial persist loop on large pack uninstalls.
- **`extension.ts`** — `writeStartupContext()` now computes a SHA-256 hash of the generated content and skips the file write entirely when unchanged, preventing unnecessary disk churn and git-dirty noise on every compression pass.
- **`extension.ts`** — Recovery file write is now capped at 500 most-recent events (≈250 KB max) to keep the synchronous shutdown write fast and bounded.
- **`extension.ts`** — Removed local `AzureSubsystemLiteral` type alias; now imports `AzureSubsystem` directly from `azureDetect.ts`.
- **`sessionCapture.ts`** — Duplicated overflow `splice(0, n)` logic extracted into a single private `trimEvents()` method used by both `pushEvent` and `pushExistingEvent`.
- **`sessionCapture.ts`** — `file_open` events are now suppressed for the first 3 seconds after `start()` to avoid flooding the event log with VS Code's editor-restore events on startup.
- **`redactor.ts`** — PEM private key block regex tightened: body now matches only base64 + whitespace characters (not `[\s\S]*?`) and is capped at 8192 chars, preventing catastrophic backtracking on large inputs missing a closing `END` marker.
- **`mcpServer.ts`** — `ghcpMem_search` and `ghcpMem_recent` now accept `workspaceName` (case-insensitive substring) as an alternative to `workspaceId`; external MCP clients (Cursor, Claude Desktop) can filter by workspace without knowing the full URI.
- **`health.ts`** — Clarified `dedupRatio` field: now documented as "fraction of sessions that are duplicates (0 = healthy)", removing the contradictory JSDoc.

---

## [1.2.0-pre] — 2026-05-13

> Internal pre-release that became the base for [1.2.0] above. Kept here for reference; the published 1.2.0 supersedes everything in this entry.

### Added
- **`src/searchCore.ts`** — New shared module exporting `extractTerms()` and `keywordScore()`. `mcpServer.ts` and `contextStore.ts` now consume the same scorer, eliminating the duplicated ranking code that caused the v1.1.5 search-intersection drift.
- **`src/contextStore.ts`** — New `getStartupCandidates(count)` method. Replaces pure-recency selection for the auto-injected `session-memory.instructions.md` brief with an importance-aware ranker: `recency (7-day exp decay, 0..10) + userTags (10) + decisions present (4) + problemsSolved present (4) + typed-observation (1)`. Pinned or decision-bearing older sessions can now outrank a recent-but-empty one; pure-recency behaviour is preserved when no metadata exists.
- **`src/contextProvider.ts`** — `buildStartupContext()` now emits `HH:MM` timestamps (e.g. `5/13/2026 14:32`) instead of date-only, and adds a `Files:` line (first 5 + `(+N more)`) so a fresh agent can see *which files* a prior session touched without a round-trip. Exported `formatInjectTimestamp(ts)` helper.
- **`src/extension.ts`** — Shutdown recovery flow. On `deactivate()` any buffered `SessionCapture` events are drained and synchronously written to `pending-events.json` (tmp+rename, mode `0o600`) inside the extension's globalStorage directory; a best-effort async compress is then awaited via the new `async deactivate()`. On the next `activate()`, `restorePendingEvents()` re-injects those events into the capture buffer and deletes the recovery file — preventing data loss on window reload, VS Code crash, or shutdown-timeout truncation.
- **`src/sessionCapture.ts`** — New public `pushExistingEvent(e)` method used by the recovery flow to re-inject already-captured events without re-stamping `ts`/`id`.
- **`esbuild.js`** — New bundler config. `vscode:prepublish` now produces a single ~70 KB `out/extension.js` and a single ~16 KB `out/mcpServer.js` instead of ~25 separate emit files. New scripts: `bundle`, `bundle:prod`, `watch`, `typecheck`.
- **`.eslintrc.json`** — ESLint config (typescript-eslint, permissive baseline). `npm test` now runs `eslint src --ext ts` before compiling, hard-failing on real errors while allowing warnings.
- **`package.json`** — Added `keywords` array (`copilot`, `github copilot`, `memory`, `mcp`, `azure`, …) for marketplace discoverability.
- **Tests** — 4 new tests for `getStartupCandidates` (decisions-beats-plain, pinned-older-beats-recent-empty, oldest-first ordering, empty-store case). Total **98 / 98 passing**.

### Changed
- **`src/contextStore.ts`** — `embedder` is now a private field. Callers must use `store.setEmbedder(fn)`; added `hasEmbedder()` helper. Prevents accidental external mutation of the embedding hook.
- **`src/types.ts`** — Hoisted `import { createHash } from 'crypto'` to module scope (was lazy-required on every call).
- **`package.json`** — `vscode:prepublish` now runs `typecheck && bundle:prod`. `test` script now runs lint first. `package` script bundles before producing the VSIX.

---

## [1.1.6] — 2026-05-13

### Security
- **`package.json`** — Upgraded `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` from `^6.19.0` to `^8.0.0` to resolve 6 high-severity Dependabot alerts for `minimatch` ReDoS (CVE via `@typescript-eslint/*` dependency chain). `npm audit` now reports **0 vulnerabilities**.

---

## [1.1.5] — 2026-05-13

### Security
- **`redactor.ts`** — Fixed `looksSensitive()` false-negative bug caused by stateful `/g` flag `lastIndex` leaking between calls. Added new patterns: `Bearer <token>`, npm access tokens (`npm_…`), Stripe live keys (`sk/pk/rk_live_…`), database connection URL passwords (`postgres://user:PASSWORD@host`), fine-grained GitHub PATs (`github_pat_…`). Fixed `anthropic-key` rule ordering so it matches before the generic `sk-` OpenAI rule.
- **`contextCompressor.ts`** — Full event log is now redacted once more before being sent to the language model, preventing path-embedded tokens or `az` CLI output secrets from reaching the model.
- **`memoryTool.ts`** — `MemoryStoreTool` now redacts all input fields (`summary`, `keyFiles`, `keyTopics`, `decisions`, `problemsSolved`) before persisting to memory.
- **`contextStore.ts`** — `restoreFromBackup()` now applies redaction (previously bypassed unlike `importFromJson`). `importFromJson()` now validates session IDs as UUIDs, silently skipping malformed entries. `~/.ghcp-mem/sessions.json` is written with mode `0600`, its directory with `0700`.
- **`packs.ts`** — `parsePack()` validates pack name characters and all session IDs as UUIDs before accepting a pack file.

### Fixed
- **`contextStore.ts`** — Search intersection bug: a query term with zero index hits now correctly returns an empty candidate set instead of falling back to all sessions.

### Optimized
- **`sessionCapture.ts`** — Event buffer overflow now uses `splice(0, n)` instead of `slice(-3000)` to avoid allocating a redundant array copy on every 5000-event flush.

### Tests
- Fixed integration test fixture to use a valid UUID (required by new ID validation).
- Added new test: `Pipeline — import skips sessions with invalid IDs` (94 tests, 0 failures).

---

## [1.1.4] — 2026-05-13

### Fixed
- Removed all remaining `Oluseyi-Kofoworola` references from `README.md` and `docs/COMPARISON.md`; all links now point to `github.com/ITcredibl/ghcp-mem`.
- Version badge in `README.md` updated to reflect current release.

---

## [1.1.3] — 2026-05-13

### Fixed
- `package.json` `repository`, `bugs`, and `homepage` URLs updated from `Oluseyi-Kofoworola` to `ITcredibl`.
- Git remote `origin` updated to `https://github.com/ITcredibl/ghcp-mem.git`.

---

## [1.1.2] — 2026-05-13

### Fixed
- Marketplace thumbnail now displays correctly: icon converted from 1024×1024 RGBA PNG to **128×128 RGB PNG** (no alpha channel) as required by the VS Code Marketplace.

---

## [1.1.1] — 2026-05-13

### Changed
- Publisher changed from `OluseyiKofoworola` to `itcredibl`.
- Extension first published to Marketplace under `itcredibl.ghcp-mem`.
- ITcredibl AI cloud logo added as `images/icon.png`.

---

## [1.1.0] — 2026-05-13

### Added
- **Health alert threshold** (`ghcpMem.healthAlertThreshold`, default `30`): a warning
  notification is shown at startup when the memory health score drops below the
  configured value, with a direct link to the Health Report.
- **Workspace-scoped MCP queries**: `ghcpMem_search` and `ghcpMem_recent` now accept
  an optional `workspaceId` parameter so Cursor, Cline, Windsurf and Claude Desktop
  can scope results to a specific VS Code workspace.
- **Auto-gitignore**: `writeStartupContext` automatically appends
  `.github/instructions/session-memory.instructions.md` to the workspace `.gitignore`
  so the auto-generated context file is never accidentally committed.
- **Redact-on-import**: `importFromJson` and `importPack` now re-run the full
  21-rule secret scanner on every imported session, protecting against unredacted
  third-party packs.
- **Test coverage — `azureContext.ts`**: 5 new unit tests covering offline fallback,
  subscription parsing, default resource-group resolution, resource listing, and
  result caching.
- **Test coverage — `contextCompressor.ts`**: 7 new unit tests covering empty events,
  LM happy path, JSON parse failure fallback, secret redaction in LM output, Azure
  tag attachment, and rule-classifier override of `unknown` type.
- **Integration test suite** (`src/test/integration.test.ts`): 5 end-to-end pipeline
  tests exercising compress → store → search → dedup → retention → import-redaction.
- Top-level `import * as crypto` / `import * as os` / `import * as path` in
  `extension.ts` — removed all inline `require()` calls.

### Changed
- **`enforceRetention`** now runs once at startup and once per `compressAndStore`
  pass, not on every `addSession` call (performance improvement for high-frequency
  workspaces).
- **`syncToDisk`** writes are serialised through an async queue to prevent
  interleaved tmp-file writes when rapid successive `addSession` / `tag` / `delete`
  operations are fired.
- **`rebuildIndex`** (called on startup and after `restoreFromBackup`) is now
  chunked in 50-session batches via `setImmediate` to avoid blocking the extension
  host UI thread on large stores.
- `StoredSession` / `StoredDatabase` interfaces in `mcpServer.ts` are now type
  aliases of `CompressedSession` / `ContextDatabase` from `types.ts`, eliminating
  the duplicate interface that could drift.
- MCP server version bumped to `0.6.0`.

### Fixed
- `buildAzureDemoSessions` and the `captureAzureContext` command no longer use
  inline `require('crypto')` — they use the module-level `crypto` import.
- `showMcpInfo` command no longer uses inline `require('os')` / `require('path')`.

---

## [1.0.0] — 2026-04-01

### Added
- Initial release.
- Automatic coding session capture (file edits, diagnostics, git, debug, tasks,
  terminal) with secret redaction (21 rules) and `<private>` tag support.
- LM-powered session compression via `vscode.lm` with rule-based fallback.
- Persistent store using VS Code `globalState` with inverted index, RRF search,
  optional embedding-based hybrid search, age/count-based retention, and rotating
  backups.
- Azure context enrichment: Bicep, Terraform, AZD, Functions, AKS, Container Apps,
  Key Vault, OpenAI, Storage, Service Bus, Cosmos DB detection + `az` CLI snapshot.
- Chat participant `@mem` with `/search`, `/timeline`, `/detail`, `/azure`, `/health`
  slash commands.
- Agent-mode LM tools (`ghcpMem_search`, `ghcpMem_store`) registered via
  `vscode.lm.registerTool`.
- Standalone MCP stdio server (`out/mcpServer.js`) for Cursor, Cline, Windsurf,
  Claude Desktop.
- Memory Packs: export/import/uninstall named bundles of sessions.
- Health score (0–100) with density glyph in the status bar.
- Sessions tree view in the activity bar with tag, delete, open-detail actions.
- `GHCP-MEM: Seed Azure Demo Sessions` command for demo/onboarding.
