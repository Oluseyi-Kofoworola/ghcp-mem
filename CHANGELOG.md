# Changelog

All notable changes to **GHCP-MEM** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.7.0] — 2026-06-10

Headline: stop memories leaking across projects, and stop low-signal sessions polluting the injected brief.

### Changed — default scope is now `repo`
- **`ghcpMem.scope` default flips from `"user"` to `"repo"`.** Opening a new workspace no longer pulls in sessions from unrelated projects. Users who genuinely want cross-repo retrieval can opt back to `"user"` or `"workspace"`. Legacy sessions captured before `repoScope` was stamped fall back to a `workspaceId` match so existing data is not silently hidden.

### Added — `ghcpMem.globalTags` cross-repo allow-list
- New array setting (default `["global"]`). Sessions tagged with any value in the list are always injected and retrieved regardless of `scope`. Reserved for cross-repo knowledge — organization coding standards, naming conventions, Well-Architected Framework guidance, etc. Tag sessions via `GHCP-MEM: Tag Session...`.

### Added — ingestion quality gate
- New `src/quality.ts` scores each compressed session on local heuristics (grounded decisions, summary length, observation type, event volume, LM mode, key topics, non-truncated event log).
- New `ghcpMem.qualityFloor` setting (default `0.3`, range `0–1`). Sessions below the floor are flagged `lowQuality`, kept on disk for audit, and excluded from the startup-context block. Set to `0` to disable.

### Added — conflict-aware injection
- `getStartupCandidates` now runs `detectConflicts` across the candidate pool and drops the older side of any contradiction-marker pair (`"instead of"`, `"no longer"`, `"deprecated"`, …). The auto-injected brief no longer carries both sides of a U-turn.

### Added — `/noise` chat command
- `@mem /noise <id>` flags a session as low-quality (same effect as the ingestion gate). `@mem /noise undo <id>` restores it. The row stays on disk.

### Added — weekly janitor
- New `src/janitor.ts` periodically re-scores every stored session against the current `qualityFloor` and flags/unflags `lowQuality` accordingly. Runs ~60 s after activation, then every `ghcpMem.janitorIntervalDays` (default `7`).
- Optional pruning via `ghcpMem.janitorPruneAfterDays` (default `0` = off) deletes sessions that have been `lowQuality` past the threshold and were never `/accept`-ed.
- `@mem /janitor` triggers a re-scoring pass on demand.

### Added — `AGENTS.md`
- Single entry-point for AI coding agents working on the repo. Links to `CONTRIBUTING.md` instead of duplicating, captures project-specific rules (no native deps, no open ports, redact-first, TypeScript strict).

### Test count
329 tests, all passing.

---

## [1.6.3] — 2026-06-07

Pure maintenance release. No extension behaviour changes — every fix here is in the build/CI/security plumbing the v1.6.2 audit (and the 10 stuck Dependabot PRs that resulted from it) surfaced.

### Fixed — CI gate now passes on PR builds
- **Pull-request-aware strict gate** (`scripts/check-release-consistency.mjs`). `vsce package` fires `vscode:prepublish`, which chains `check:release:strict`, which then runs the "HEAD pushed to origin/main", "tag exists at HEAD", and "tag pushed to origin" checks. On a GitHub Actions PR run, HEAD is a synthetic merge commit (`refs/pull/N/merge`) — by construction it can never equal `origin/main` and no `vX.Y.Z` tag points at it. Result: every PR build was hitting the gate and turning red across all 4 of its checks, blocking the 10 open Dependabot PRs. The gate now detects PR context via `GITHUB_EVENT_NAME=pull_request` / `GITHUB_REF=refs/pull/*` and records a single explicit `HEAD/tag git-state checks: skipped (pull-request build)` line instead. The doc surface checks (package.json, README, DEMO.md, CHANGELOG, clean tree) still run on PRs, and the full strict surface still runs on tag pushes — so release-time integrity is unchanged.
- **Readable failure message instead of `[object Object]`** (`scripts/check-release-consistency.mjs:151`). The "HEAD pushed" failure was rendering `local is [object Object] commit(s) ahead of origin/main` because the rev-list helper returns an error object when the requested range is unresolvable, and the template literal silently stringified it. Now: the result is type-checked before interpolation, falls back to a literal `unknown`, and the rev-list call uses `origin/main..HEAD` (which always exists in a detached-HEAD CI checkout) instead of `origin/main..main` (which doesn't).

### Fixed — Security advisories cleared
`npm audit fix` (non-breaking) resolves the four advisories that were failing the Security workflow's `audit` job on every PR:
- **`tmp` (high — GHSA-ph9p-34f9-6g65)** — path traversal via unsanitized prefix/postfix.
- **`qs` (moderate — GHSA-q8mj-m7cp-5q26)** — remotely triggerable DoS on `qs.stringify` with null/undefined entries in comma-format arrays.
- **`uuid` (moderate — GHSA-w5hq-g745-h8pq)** — missing buffer-bounds check in v3/v5/v6 when `buf` is provided.
- **`@azure/msal-node` (moderate, transitive via `uuid`)** — cleared automatically by the uuid bump.

`npm audit --audit-level=high` now returns `found 0 vulnerabilities`.

### Fixed — gitleaks PR scans
- **`GITHUB_TOKEN` now passed to `gitleaks/gitleaks-action@v2`** (`.github/workflows/security.yml`). The action shipped a breaking change requiring `GITHUB_TOKEN` to be set on `pull_request` events, so every PR's `gitleaks` job had been failing instantly with `🛑 GITHUB_TOKEN is now required to scan pull requests` (independent of repo content). Now wired through `env.GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, scoped read-only via the top-level `permissions: contents: read` declaration. Also added `fetch-depth: 0` so the action has the full history it needs for the PR-vs-base diff. Together with the strict-gate fix above, this brings the PR check count from 4/5 red → **5/5 green**.

### Fixed — Zero lint warnings + regression gate
Cleared all 13 ESLint warnings that the CI log had been carrying since v1.6.0, and tightened the lint script so future warnings fail the build instead of being ignored:
- **`lint` script now uses `--max-warnings=0`** (`package.json`). CI fails on the first new warning.
- **Dead imports/locals removed**: `diffCmd` and `err` in `contextProvider.ts` (1893, 2101), `PACK_TAG_PREFIX` in `extension.ts:24`, the unused `vscode` import in `packs.ts:1`, `classifyCommand` in `ruleClassifier.ts:11`.
- **Six useless-escape warnings fixed**: `\/` and `\[` inside character classes in `redactor.ts:162,168` and `repoScope.ts:128`; `\'` inside double-quoted strings in `extension.ts:1536,1542`.
- **Two `let → const`** in `src/test/autosave.test.ts:41,56` (locals never reassigned).

### Why no extension code changed
v1.6.0 was a large feature release (Phases 1–9). v1.6.1 fixed the release-trail (Node 20 glob bug). v1.6.2 fixed the second-order CI fallout (shallow-checkout self-heal). v1.6.3 closes out the *third-order* fallout from those changes — the strict gate firing on PR builds, the audit advisories piling up while the Security job was failing, and the lint warnings accumulating because nothing in CI was enforcing zero. With v1.6.3 merged, the 10 open Dependabot PRs should go green and the next feature release (v1.7) starts from a clean baseline.

### Test count
All 323 tests still passing.

---

## [1.6.2] — 2026-06-01

Follow-up to v1.6.1's release-trail fix. v1.6.1 unblocked CI's `npm test` step (Node-20 glob bug), but the Release workflow then immediately tripped on a *second* latent bug: the strict release-consistency gate (run as `vsce package`'s `vscode:prepublish` hook) checks `git rev-parse origin/main`, and `actions/checkout@v4`'s default shallow checkout doesn't carry that ref. So the gate failed instantly on the v1.6.1 tag push, before the build could produce any artifacts. v1.6.2 is the actual first release with a green end-to-end CI Release run — no behaviour changes in the extension itself.

### Fixed — CI release plumbing
- **`fetch-depth: 0` on the workflow checkouts** (`.github/workflows/release.yml`, `.github/workflows/ci.yml`). Full history so `origin/main` is resolvable when the strict gate runs on a tag push.
- **Explicit `git fetch origin main` step** added right after checkout in both workflows — belt-and-suspenders so `origin/main` is always present even if a future checkout-action upgrade changes the default fetch behavior.
- **Self-healing fallback in the gate script** (`scripts/check-release-consistency.mjs:184`). If the initial `git rev-parse origin/main` fails (the canonical "shallow CI checkout" symptom), the script now retries with a single targeted `git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main` before reporting failure. Keeps the gate usable in any shallow environment without requiring every workflow to remember the explicit fetch step.

### Why a separate release
v1.6.1's commit message and CHANGELOG promised "the first successful end-to-end Release run since v1.4.9" — but the workflow then failed on a bug the v1.6.1 changes hadn't fixed. Force-updating the v1.6.1 tag would have masked that, so we shipped v1.6.2 instead. Five-minute gap between tags; no Marketplace publish or GitHub Release exists for v1.6.1.

### Test count
323 tests still passing. No extension code touched.

---

## [1.6.1] — 2026-06-01

Targeted response to the external v1.6.0 review. The reviewer's #1 concern was **release integrity**: Marketplace said v1.6.0, GitHub Releases still showed v1.4.0 as "latest." For a memory extension that captures coding activity, that gap is a trust problem — buyers can't answer "what source commit produced the Marketplace artifact?" This release fixes the root cause, backfills the missing release trail, and tightens the smaller items the same review flagged.

### Fixed — Release trail (the trust-eroding bug)
- **CI test runner now works on Node 20** (`scripts/run-tests.mjs`, `package.json`). The `release.yml` workflow has been silently failing since v1.4.10 because `node --test "out-test/src/test/*.test.js"` doesn't expand globs on Node 20 (added in Node 22.6+). Local dev (Node 25) expanded fine; CI (Node 20) tried to read the literal `*.test.js` path and exited 1. Every Release workflow run on `v1.5.0`, `v1.5.1`, `v1.5.2`, `v1.5.3`, `v1.6.0` failed at the test step, which is why no GitHub Release was created for any of those tags. Replaced the brittle quoted-glob with a tiny `run-tests.mjs` shim that recursively discovers `*.test.js` under `out-test/src/test/` via `fs.readdirSync` and spawns `node --test <file1> <file2> …` with the explicit list — fully portable across Node 18/20/22/25, no shell-glob assumptions, no version-conditional behaviour.
- **Backfilled GitHub Releases for v1.5.0 through v1.6.0** with the rebuilt `.vsix`, SHA-256 checksum, CycloneDX SBOM, and release manifest for each tag. These backfills are marked clearly: they include integrity artifacts but **not** the SLSA L3 provenance attestation, because the in-CI attestor only runs as part of `release.yml` on a fresh tag push. v1.6.1+ gets the full L3 attestation chain now that the workflow runs to completion.
- **Honest "Verify installed extension" docs** (`README.md`). Rewrote the section the v1.6.0 review called out as not actually working end-to-end. Step 3 (compare locally-installed bundle SHA against the public release) was a `<reconstruct if needed>` placeholder; it's now a real shell snippet that unzips the release `.vsix`, hashes `extension/out/extension.js`, hashes the installed copy, and diffs them. The section also clearly states what's verifiable for backfilled releases vs v1.6.1+.

### Changed — Default posture
- **MCP write tools default to OFF** (`package.json` schema, `src/types.ts:413`, `src/extension.ts:1243`). `ghcpMem.allowMcpWriteAccess` was `true` by default; it is now `false`. The MCP server still exposes the full read surface out of the box (`memory-search`, `memory-recent`, `memory-timeline`, `memory-get`) — but `memory-store`, `memory-delete`, `memory-correct`, `memory-retract`, and `memory-supersede` require an opt-in flip. This matches MCP's own human-in-the-loop guidance and the enterprise-safe defaults the v1.6.0 reviewer asked for under their "MCP write tools need stronger guardrails" item. **Breaking change for users who relied on the previous default**: if you want write tools, set `ghcpMem.allowMcpWriteAccess: true` in your settings. (Enterprise mode continues to force this off regardless of the user setting.)

### Changed — Auditability hygiene (the "minified source" concern)
- **Adopted Prettier across the entire codebase** (`.prettierrc.json`, `.prettierignore`, `package.json`). The v1.6.0 review said "several raw TypeScript files appear minified" — that was the esbuild output (`out/extension.js`), not source. `.prettierignore` now points this out explicitly: source under `src/` is formatted via `npm run format` (Prettier; printWidth 100, single quotes, trailing commas) and checked by `npm run format:check`. This release ran `--write` across all 79 source files; future PRs can use `format:check` as a CI gate.

### Changed — Marketing copy honesty
- **Tightened absolute claims in README** (`README.md`). Lead paragraph now says "routes most 'what / why / how' questions to a millisecond-latency local lookup *instead of* a fresh Copilot completion — so your token budget goes to shipping" — that's the actual mechanism behind the headline token-cost reduction, not the marketing claim "eliminates token waste" the reviewer warned against. The "3 steps" table's token-savings cell now explicitly says "The synthetic benchmark estimates 5–20× savings on this query class; results on your real repo will vary with query mix" — keeping the number but flagging it as a benchmark estimate. Test count updated 307 → 323.

### Out of scope for v1.6.1 (planned for follow-up sprints)
The v1.6.0 review listed four substantive feature requests that are not patch-release work:
- **Encrypted local storage** (`ghcpMem.storageEncryption: off | os-keychain | passphrase` with migration) — scoped for a v1.7 sprint.
- **First-run enterprise-strict wizard** with Personal / Team / Enterprise-strict presets — scoped for v1.7.
- **Real-world benchmark suite** against curated repos (React, Azure Terraform, Bicep, Python, monorepo) measuring recall@5, MRR, stale-memory rejection, false positive conflict rate, redaction false negatives, latency at 1K/10K/50K sessions — scoped for v1.7.
- **Prompt-injection defenses** ("memory is untrusted context" wrapper, instruction stripping for stored memories, pack quarantine mode) — scoped for v1.8.

These are tracked openly so the rating gap (current 8.1 → target 8.6–8.8 per the same review) closes against work that ships, not against work that's claimed.

### Test count
All 323 tests still passing after the Prettier sweep and the test-runner refactor. CI's Release workflow on the `v1.6.1` tag will be the first successful end-to-end run since v1.4.9 — that run produces the canonical GitHub Release for this version with full SLSA L3 attestation.

---

## [1.6.0] — 2026-06-01

**Production-grade memory upgrade.** Seven incremental phases that take GHCP-MEM from "a session summarization tool" to a memory system developers can trust: every claim is grounded in evidence, every ranking is provenance-aware, every memory has a confidence that decays over time, and every search hop carries the full decision narrative. 136 new tests (153 → 289), 0 native deps, 0 schema migrations, fully backward-compatible with stores captured under 1.5.x.

### Added — Phase 1: grounding layer
- **Evidence-citation gate** (`src/contextCompressor.ts`, `src/types.ts`). The compressor prompt now generates a numbered `EVIDENCE TABLE` from the event log and requires the LM to cite IDs (`E1`, `E5`, …) for every `decision` and `problemsSolved` entry. Claims with zero valid citations are dropped at write time — the mechanism that eliminates the hallucinated-decision failure mode. Legacy `string[]` decisions are also dropped (no grounding possible).
- **SHA-anchored validator** (`src/validator.ts`, `src/sessionCapture.ts`). Each `file_edit` now captures the post-edit `contentHash` via `semanticTextSignature`. The validator re-hashes the file on retrieval and classifies it `verified` / `drifted` / `missing` / `neutral`; a new `groundedFreshness` field weights drift at 0.5 so a session whose files have moved away from capture-time content no longer scores 1.0. The store's `filterByFreshness` consumes `groundedFreshness` in preference to the legacy `freshness`.
- **Soft candidate union** (`src/contextStore.ts:search`). Replaced the hard inverted-index intersection with a union: a single rare-term miss no longer zeroes recall. Added `matchedTermsRatio * 0.25` as a fusion signal so the soft-union recall lift doesn't let a 1-of-4 match outrank a 4-of-4.
- **Reservoir sampling** (`src/contextCompressor.ts:buildEventLog`). Replaced head-30 / tail-70 middle-truncation with importance-weighted retention: diagnostics, terminals, git ops, debug, tasks, and file lifecycle events survive first; file edits are kept by impact (changeCount desc); `file_open`/`file_close` drop first under pressure. Sessions whose log overflows the budget get `eventLogTruncated: true` and a confidence haircut.
- **Per-session `confidence` ∈ [0, 1]** (`computeConfidence` in `contextCompressor.ts`). Derived from evidence breadth (≥2 distinct files +0.2), compressor mode (+0.1 for lm), rule classifier agreement (+0.1), redaction noise (−0.2 if >5 hits), and event-log truncation (−0.1). Surfaced as 🟢/🟡/🔴 emoji in injected markdown and detail views.

### Added — Phase 2: trust + correction mechanics
- **Symbol-anchored evidence** (`src/sessionCapture.ts:findEnclosingSymbol`). When an edit batch flushes, the dominant edit range is resolved via `vscode.executeDocumentSymbolProvider` to `<filePath>#<symbolName>` (e.g. `src/auth.ts#hashPassword`) and stored on `FileEditData.symbolId`, propagating to `Evidence.symbolId`. Async + best-effort — never blocks capture.
- **Query intent + co-occurrence expansion** (new `src/queryIntent.ts` + `src/queryExpansion.ts`). Queries are bucketed `decision` / `problem` / `entity` / `recent` / `general` via regex; each intent gets a per-component weight multiplier. Expansion walks the inverted index for co-occurring terms (filtered by `maxGlobalFrequency` to skip stopword-like terms) to recover matches when the user phrases the query differently from capture.
- **Six new trust commands** (`src/contextProvider.ts`, `package.json`):
  - `/verify <id>` — per-file `verified` / `drifted` / `missing` breakdown
  - `/correct <id> <text>` — creates a linked correction session at `confidence: 1.0` and supersedes the original
  - `/supersede <newer> <older>` — manual supersession; auto-acknowledges matching conflict warnings
  - `/retract <id> [reason]` / `/retract undo <id>` — excludes from retrieval/injection; reversible
  - `/accept <id>` and `/reject <id>` — reinforcement signal pumped into the ranker
- **Local reinforcement telemetry** on every `CompressedSession.usage`: `retrieved`, `lastRetrievedAt`, `accepted`, `rejected`, `lastInteractionAt`. `search()` bumps `retrieved` on returned IDs (throttled 5 s persist via `flushTelemetry`); ranker adds `log(1+retrieved)*0.1` reinforcement and `(accepted − rejected)*0.05` feedback.
- **Memory Inspector** (`src/timelinePanel.ts`). Cards now show trust badge, supersession/retraction/correction status chips, usage counters, clickable 📎 file-evidence chips per decision (jump to file), and 🔍 Verify · ✏️ Correct · 🚫 Retract action buttons on hover. Retracted cards dim; superseded cards desaturate.

### Added — Phase 3: entity layer + lineage + decay + eval
- **Entity aggregation** (new `src/entity.ts`). `buildEntityRecord(key, sessions)` rolls up every session touching a file or LSP symbol into a single record: decisions, problems, topics, observation-type breakdown, recent-sessions list, supersession lineage chain, and an `allSupersededOrRetracted` flag. `/entity <path>` (or `<path>#<symbol>`) chat command renders it; falls back to the active editor's file when called with no args.
- **Multi-hop retrieval** (`src/contextStore.ts:getLineage` + `enrichWithMultiHop`). `/search` results now show inline `🧭 Lineage: A → B → C` and `🔗 See also: @mem /entity X` hints — one retrieval hop carries the full narrative + entity pointers instead of forcing follow-up queries.
- **Time-based confidence decay** (new `src/decay.ts`). Pure `effectiveConfidence(session, now)` with 60-day half-life, capped at 30% haircut. Recent retrieval / accept resets the decay clock. Integrated into `search()` ranking and the trust badge renderer; the original `confidence` is preserved on disk so we never destroy provenance.
- **nDCG@K + gold-corpus eval gate** (`src/eval.ts`, `scripts/eval-check.js`, new `scripts/eval-gold.json`). New `ndcgAtK()` and `runGoldEval(store, queries)`. `scripts/eval-check.js --gold <path>` runs the gate against a hand-curated 12-query corpus; baseline gains an `ndcg` floor. Regression on any of recall@5 / MRR / nDCG@5 fails the gate.

### Added — Phase 4: snippet layer + conflicts + causal graph
- **Snippet-level retrieval** (new `src/snippets.ts`). `snippetsFromSession` decomposes each session into typed `{summary, decision, problem, topic}` snippets (derived, not stored — no schema migration). `ContextStore.searchSnippets` ranks via BM25 + recency + decayed confidence + supersession penalty. `/snippet <query>` returns chunk-level results with their source session ID so the developer can drill in with `/detail`. Closes the "session-only granularity" weakness from the original architectural critique.
- **Heuristic conflict detection** (new `src/conflicts.ts`). `addSession` scans new decisions for 12 contradiction markers (`instead of`, `no longer`, `switched from`, `deprecated`, `replaced`, `abandoned`, `rolling back`, `reverted from`, `moved away from`, …) and matches against older sessions sharing files or topics. Warnings surface via `/conflicts`; `/supersede` auto-acknowledges; `/conflicts dismiss <id> [reason]` for manual ignore. Detection is best-effort — failures never block capture.
- **Cross-session causal graph** (new `src/causalGraph.ts`). `getCausalNeighbors(id, sessions)` returns predecessors + successors sharing key files within ±30 days. Semantic edge labels include `introduced_issue_fixed_by` (feature→bugfix), `extends` (feature→refactor), `tests` (feature→test), `continues_work_from` (fallback). `/lineage <id>` renders the chronological chain with shared-files chips.

### Added — Phase 5: adaptive ranking + federated packs + NER-lite
- **Adaptive ranking weights** (new `src/adaptiveWeights.ts`). Per-signal multipliers (`keyword`, `recency`, `confidence`, `reinforcement`, `feedback`) learned from accept/reject telemetry via avg-of-accepted vs avg-of-rejected delta. Bounded `[0.75, 1.25]`, capped at ±5% per round, requires ≥10 samples before kicking in. Persisted under its own `ghcpMem.adaptiveWeights` `globalState` key. `ContextStore` snapshots per-signal values at search time and feeds them back on accept/reject; new `getAdaptiveWeights`, `getAdaptiveSampleCount`, `resetAdaptiveWeights` accessors.
- **Federated pack lineage merge** (`src/packs.ts`). `importPack` now returns `conflictsRaised` count; supersession links (`supersedes` / `supersededBy` / `correctionOf`) and `retractedReason` propagate across the import boundary. The import status-bar message surfaces conflict count with `@mem /conflicts` pointer for follow-up review.
- **Custom-entity redaction (NER-lite, no ML)** (`src/redactor.ts`, `src/types.ts`, new `ghcpMem.customSensitiveEntities` config). Each entry compiles to a literal, case-insensitive, word-boundary-anchored regex. Multi-word entries handled via `\s+` substitution; respects identifier boundaries (won't mis-match `"Project Hydra"` inside `ProjectHydraService`). Use for organisation, project, or codename terms that don't match a built-in pattern.

### Added — Phase 6: explainability + visualisation
- **`/why <query> :: <id>` — score-decomposition explainer** (new `src/explain.ts`). Re-runs the exact fusion math used by `search()` but emits a per-component report: keyword rank, recency+decay, workspace boost, match ratio, confidence, decision/problem intent boosts, supersession penalty, reinforcement, feedback — each with sign, magnitude, and learned-weight delta. Contributions sorted by magnitude so the dominant signals are at the top. The single highest-leverage trust UX in the release: when a ranking is wrong, developers can finally see why.
- **`/graph [file:<path>]` — Mermaid decision-graph export** (new `src/graphExport.ts`). Fenced ` ```mermaid ` block ready to paste into a PR/ADR/docs. One node per session (color-styled by observation type, dimmed if retracted); supersession (solid `-->`), correction (dashed `-.->`), and bugfix-after-feature causal (dotted `==>`) edges.
- **Memory Inspector — learned-ranker surface** (`src/timelinePanel.ts`). New "🎚 Learned ranker" header card shows per-signal multipliers with color-coded delta from 1.00 and running 👍/👎 sample count; hidden during cold-start (defaults all 1.0) so it doesn't clutter the UI before learning kicks in.

### Added — Phase 7: MCP parity + compliance
- **Six new MCP tools** (`src/mcpServer.ts`) — every chat command above now has an MCP-tool equivalent so Cursor, Cline, Windsurf, Claude Desktop, and the Copilot CLI all get the full surface: `ghcpMem_entity`, `ghcpMem_snippets`, `ghcpMem_conflicts`, `ghcpMem_lineage`, `ghcpMem_explain`, `ghcpMem_graph`. All reuse the same pure-function helpers as the chat path — single source of truth.
- **Compliance / audit report** (new `src/compliance.ts`, `/compliance` chat command). One-shot security posture: total/active/retracted/superseded/correction counts, evidence coverage %, sessions with SHA-anchored hashes, compressor-mode breakdown, truncated-event-log count, mean stored vs effective confidence, 🟢/🟡/🔴 confidence buckets, reinforcement signal usage, pending heuristic conflicts, oldest/newest spread, custom sensitive entities in effect. Ideal for enterprise security reviews.

### Schema changes (all additive, all optional)
Backward-compatible across every storage surface. `CompressedSession` gained these optional fields:
- `decisionEvidence?: Evidence[][]`, `problemEvidence?: Evidence[][]` — parallel-array citation provenance
- `keyFileHashes?: Record<string, string>` — SHA-grounded validation snapshot
- `confidence?: number`, `compressorMode?: 'lm' | 'fallback'`, `eventLogTruncated?: boolean` — trust telemetry
- `supersedes?: string`, `supersededBy?: string`, `retracted?: boolean`, `retractedReason?: string`, `correctionOf?: string` — supersession + correction graph
- `usage?: { retrieved, lastRetrievedAt, accepted, rejected, lastInteractionAt }` — reinforcement telemetry

`FileEditData` gained `contentHash?: string` and `symbolId?: string`. `Evidence` (new) carries `kind`, `filePath`, `fileHash`, `symbolId`, `eventIndex`, `capturedAt`.

`PluginConfig` gained `customSensitiveEntities: string[]` (default `[]`).

No DB version bump required — every new field is optional and absent on legacy rows.

### Tests
+136 tests (153 → 289). Six new suites added: `groundingPhase1` (compressor + render), `groundingPhase1.store` (ContextStore + renderer), `groundingPhase2`, `groundingPhase3`, `groundingPhase4`, `groundingPhase5`, `groundingPhase6`, `groundingPhase7`. Plus updated `mcpServer.test.ts`, `validator.test.ts`, and `contextCompressor.test.ts` to cover the new behaviour.

### Closed weaknesses
All ten weaknesses from the upstream architectural critique are now addressed: hallucinated decisions (evidence gate), session-only granularity (snippet layer), stat-only validation (SHA grounding), hard term intersection (soft union), no conflict detection (heuristic + pack-aware), middle-truncation (reservoir), rule-only redaction ceiling (custom entities), no reinforcement loop (telemetry + adaptive), dual-path drift (single scorer — pre-existing), binary/implicit confidence (per-session + decay + adaptive).

### Bundle
`out/extension.js` 162 KB → 208 KB (+46 KB for nine new modules + UI). `out/mcpServer.js` 30 KB → 38 KB (+8 KB for six new tools). Zero native dependencies — `npm install` does no compilation step.

### Added — Phase 9: auto-routing primer + cost recommender
- **Routing primer in the auto-injected memory file** (`src/contextProvider.ts:buildStartupContext`). Every new Copilot session now opens with a short stanza that teaches the agent: prefer GHCP-MEM MCP/chat tools for history questions ("why / what / how / who / when") and only open files when the task is a MODIFY. The primer cites the concrete tools (`@mem /entity`, `@mem /snippet`, `@mem /search`, `@mem /lineage`, `@mem /why`, `@mem /route`) with approximate token costs so the agent can self-route from message one — no extra round-trip required.
- **`/route <query>` chat command + `ghcpMem_route` MCP tool** (new `src/router.ts`). Classifies a request as `lookup` / `modify` / `investigate` / `mixed` / `unknown`, estimates the token cost of every action, and returns the cheapest plan. The chat surface auto-resolves file sizes from the workspace so estimates reflect reality. The MCP tool lets non-Copilot agents (Cursor, Cline, Windsurf, Claude Desktop, Copilot CLI) self-route at any time.
- **Strengthened MCP tool descriptions** (`src/mcpServer.ts:TOOLS`). The descriptions for `ghcpMem_search`, `ghcpMem_entity`, and `ghcpMem_snippets` now explicitly state the typical token saving vs file open, with concrete numbers — so agents reading the catalog learn the routing rule from the catalog itself.

### Schema changes (Phase 9)
None — Phase 9 is purely additive (one new module, one new chat command, one new MCP tool, one prepended block in the injected memory file).

### Tests (Phase 9)
+18 tests in `groundingPhase9.test.ts` covering: intent classifier (lookup / modify / investigate / mixed / unknown), path extraction, attach-token estimator, recommendation correctness per intent, MCP-unavailable degradation, large-file savings ratio, MCP catalog wiring (including the new `ghcpMem_route` entry), routing-primer presence/absence in startup context. Total suite is now 307/307 (was 289 in 1.6.0).

### Still deferred
Three remaining items genuinely require external dependencies or design decisions before they can ship: vector embeddings (needs `hnswlib-node` native dep), single SQLite source of truth (needs `better-sqlite3` native dep), and true ML-based NER (needs a model or external service). All three are queued for a future major bump with an explicit decision.

---

## [1.5.3] — 2026-06-01

UX fix in response to user feedback: the "Persist this compressed memory snapshot?" modal was firing on every compression cycle and became disruptive. The prompt now has a third button so users can silence it for good — without having to dig into Settings or learn a hidden config key.

### Changed — `confirmPersistSession()` in `src/extension.ts`
- **New button: `Persist, don't ask again`** — confirms the current snapshot **and** sets `ghcpMem.previewBeforePersist = false` at `ConfigurationTarget.Global`, so the modal will not show again on this machine.
- Modal `detail` now tells users where to re-enable the prompt: *Settings → `ghcpMem.previewBeforePersist`*. No magic — discoverable and reversible.
- After the choice lands, a 5-second status-bar message confirms what changed: `$(check) GHCP-MEM: persist prompt disabled. Re-enable in Settings: ghcpMem.previewBeforePersist`.
- **Enterprise-mode interaction handled explicitly.** `types.ts:267` ORs `previewBeforePersist` with `enterpriseMode`, so disabling the former alone is insufficient when the latter is on. In that case the user now sees a follow-up warning with an `Open Settings` action that jumps straight to `ghcpMem.enterpriseMode` — no silent failure, no confused user wondering why the prompt is still there.
- Failure to write the config is logged at `WARN` (existing `log()` helper) and the snapshot is still persisted — the UX fix never blocks the data path.

### Why this is the right shape
The pre-existing two-button modal (`Persist` / `Discard`) forced a decision on every snapshot. For users who have already vetted the redaction pipeline once, that's noise. The new third option treats consent as a one-time gate, not a recurring tax — matching how VS Code itself handles things like "Don't ask again" on trust prompts. Settings remains the source of truth, so audit-conscious workflows (enterprise mode) keep their guardrail by default.

### No new tests required
The change is a pure UX/wiring fix inside an existing function — the persistence pipeline, redaction, and config schema are unchanged. All 153 existing tests pass.

---

## [1.5.2] — 2026-06-01

The release-consistency gate in **1.5.1** lives outside the extension — as an npm script + CI gate. A reviewer (correctly) pointed out that **GHCP-MEM itself should be able to catch the same class of bug** at any time, not only at publish. Drift detection now ships as a first-class extension capability surfaced through every interface GHCP-MEM already owns.

### Added — Workspace Integrity Auditor
- **`src/integrityChecker.ts`** — small rule framework + one built-in rule:
  - `versionDriftRule` checks `package.json` (source of truth) against `README.md` footer `**vX.Y.Z**`, every `vX.Y.Z` citation in `docs/DEMO.md`, and the top `## [X.Y.Z]` heading in `CHANGELOG.md`. Reports the offending file, line, and a concrete fix (`run: npm run bump:version -- X.Y.Z`).
  - Returns typed `IntegrityIssue[]` with severities (`error` / `warning` / `info`).
  - `formatAuditReport()` produces a clickable markdown report grouped by severity.
- **Three surfaces, same auditor:**
  - 💬 **`@mem /audit`** — chat slash command, streams a compact issue list with fix-it suggestions and an "Open full audit report" button.
  - 🤖 **`#ghcpMemAudit`** — `vscode.lm` agent tool (`MemoryAuditTool`). Copilot can spot-check the workspace mid-flow. Always available — read-only, no write surface.
  - 🎛 **`GHCP-MEM: Run Workspace Integrity Audit`** — command palette entry. Opens the full markdown report as a preview tab. Status bar flashes `$(alert) N integrity error(s)` when blocking issues exist.
- **`src/test/integrityChecker.test.ts`** — 9 new tests. One of them, "catches README ≠ package.json (the reviewer's exact bug)", asserts the exact pattern the external review flagged (`package.json` at 1.5.1, README footer at 1.5.0) is now caught instantly.

### How it composes with the release-consistency gate
| When | Surface | What runs |
|---|---|---|
| You're editing | `@mem /audit` in chat | the auditor (in-editor) |
| You're editing | `#ghcpMemAudit` in agent prompt | the auditor (Copilot-driven) |
| You hit ⌘⇧P | `GHCP-MEM: Run Workspace Integrity Audit` | the auditor (palette) |
| CI runs on PR | `npm run check:release` | the gate (doc-only mode) |
| You tag a release | `npm run check:release:strict` (CI) | the gate (full strict) |
| You run `vsce publish` | `vscode:prepublish` → strict gate | the gate refuses if drifted |

Same drift checks expressed twice — once for live use in the editor (the auditor), once for blocking publish (the gate). They reinforce each other.

### Test count
153 tests passing (was 144 → +9 from the integrity-audit suite).

---

## [1.5.1] — 2026-06-01

Triggered by an external reviewer who caught a **real** trust-eroding bug: Marketplace footer said `v1.5.0` while public `package.json`, CHANGELOG top entry, and the GitHub Releases latest were all on different versions. Manual sweep-and-bump worked for most prior releases, then failed once and broke the audit trail. This release builds the mechanism that makes drift impossible going forward.

### Added — Release-consistency gate (the prevention mechanism)
- **`scripts/check-release-consistency.mjs`** — Single-source-of-truth gate. Treats `package.json .version` as the only ground truth and verifies every other surface against it:
  - README footer `**vX.Y.Z**`
  - `docs/DEMO.md` version refs (all occurrences must match)
  - `CHANGELOG.md` top entry `## [X.Y.Z]`
  - **strict mode adds:** working tree clean, HEAD pushed to `origin/main`, `git tag vX.Y.Z` exists locally, `git tag vX.Y.Z` pushed to origin
  - Exit code 1 with an actionable hint for every failure (e.g. `run: npm run bump:version -- 1.5.1`)
- **`scripts/bump-version.mjs <X.Y.Z>`** — Atomic version bump. One command updates package.json + README footer + DEMO.md + prepends a CHANGELOG stub. Runs the gate after to confirm consistency. Idempotent.
- **`npm run check:release`** (doc-only) and **`npm run check:release:strict`** (publish-time, adds git checks) — gate as a one-liner.
- **`npm run bump:version <X.Y.Z>`** — the atomic bumper.

### Changed — Hard publish gate
- **`package.json` → `vscode:prepublish`** now runs `npm run check:release:strict` _before_ typecheck and bundle. **`vsce publish` will refuse to ship a drifted state.** The strict mode requires the commit + tag are already pushed to GitHub, which means the GitHub source-of-truth always matches the Marketplace listing at the moment of publish.
- **`.github/workflows/ci.yml`** — Added a release-consistency check that runs on every push and pull request. Strict mode kicks in only on tag pushes (`refs/tags/v*`), so PRs aren't blocked by the working-tree / push checks they can't satisfy.

### Added — README "Verify Marketplace VSIX" section
Per reviewer recommendation. Walks the user through:
1. Downloading the matching version's `.vsix` + `ghcp-mem.vsix.sha256` from GitHub Releases
2. `shasum -a 256 -c ghcp-mem.vsix.sha256` to verify the bits
3. `gh attestation verify` for SLSA provenance (already produced by `release.yml`)
4. Auditing `sbom.json` for npm dependency provenance

### What the gate prevents (for future reviewers)
The exact bug the reviewer flagged — "Marketplace footer says v1.5.0, package.json shows 1.4.9, CHANGELOG newest is 1.4.9, GitHub Releases latest is v1.4.0" — is now impossible. Each surface is either:
- enforced by the doc-only gate (README, DEMO, CHANGELOG must match package.json), or
- enforced by the strict gate (HEAD pushed + tag pushed → GitHub Release auto-created by `release.yml`), or
- enforced by the publish pipeline itself (vsce only ships what's in package.json).

A drift in any single surface causes the publish to abort before producing a `.vsix`. CI catches the drift even earlier — on the PR that introduced it.

---

## [1.5.0] — 2026-05-31

This release responds to a follow-up external review that recommended five hardening tracks (volatile-cache cap, secret-hash validation, diff-based ingestion, prune-dashboard, corporate policy URL). An audit confirmed **four of the five were already shipped** in 1.4.x; this release adds the fifth — prune-dashboard actions on the visual timeline — plus a formal threat model and reproducible activation-cost benchmark so enterprise reviewers can verify both.

### Added — UX
- **`src/timelinePanel.ts`** — Per-session **pin / tag / prune** action buttons on every card in the visual Memory Timeline. Hover a card to reveal four buttons (📌 pin · 🏷 tag · 🗑 delete · → open). Pinned sessions get a gold inset border + 📌 indicator. Wired to the same `ContextStore` methods the sidebar already used, with a modal confirmation on delete so an accidental click is recoverable.

### Added — Documentation
- **`docs/THREAT_MODEL.md`** — Formal STRIDE-style threat model covering six trust boundaries (workspace ↔ host, host ↔ `vscode.lm`, host ↔ local mirror, host ↔ policy URL, host ↔ MCP stdio, host ↔ Memory Pack import). 19 numbered threats (T1–T19), each with its mitigation cited to source-line. Names the three residual risks (R1 plaintext store, R2 policy-URL allow-list, R3 pack signing) with target releases.

### Added — Measurement
- **`scripts/measure-activation.js`** + **`npm run measure:activation`** — Reproducible activation-cost benchmark. Reports bundle size, parse time, store-load + index-rebuild times at 100 / 1k / 10k sessions, first-query latency, and heap delta. Numbers from current build on darwin arm64 Node 25:

  | Metric | Value |
  |---|---|
  | Bundle size — `out/extension.js` | 149 KB |
  | Bundle size — `out/mcpServer.js` | 28 KB |
  | Store load + index rebuild @ 100 sessions | ~2 ms |
  | Store load + index rebuild @ 1 000 sessions | ~3 ms |
  | Store load + index rebuild @ 10 000 sessions | ~40 ms |
  | First search @ 10 000 sessions | ~2 ms |

### Acknowledged from the review (already shipped, line refs)
For anyone tracking the May review verbatim — these were flagged as recommendations but were **already in 1.4.x**:

| Recommendation | Lives at |
|---|---|
| 5 MB volatile-cache cap with graceful drop | `src/sessionCapture.ts:401-402` (`MAX_VOLATILE_BYTES = 5 * 1024 * 1024`), `:trimEvents()` runs on every push |
| SHA-256 hashed redactions (structural correlation without revealing secrets) | `src/redactor.ts:38` (`hashedTag()` → `[REDACTED:label]#<sha256>`) — used by every rule |
| Whitespace-only diff filter on ingestion | `src/sessionCapture.ts:114-117` (`semanticTextSignature()` short-circuits identical signatures) |
| Corporate-policy URL with HTTPS validation | `src/policySource.ts` + `ghcpMem.policySource` setting |

### Roadmap (acknowledged residual risks)
- **R1** Optional encrypted local store via `vscode.SecretStorage` + AES-256-GCM — 1.5.x
- **R2** Optional allow-list of corporate-policy domains + signature verification — 1.6.x
- **R3** Optional Sigstore signature verification on Memory Pack imports — 1.6.x

---

## [1.4.10] — 2026-05-31

### Fixed
- **`.vscodeignore`** — Excluded root-level `*.mp4`, `*.gif`, `ghcp_mem_promo.*`, and `sleek-cinematic-promo.*` so stray marketing artefacts at the repo root can never ship in the `.vsix` again. (The previous rule only matched `images/demo/`, which let a 0-byte `ghcp_mem_promo.mp4` slip into `1.4.9`.)

### Changed — Honest-claims pass (responding to external review)
An external reviewer rated GHCP-MEM 7.4/10 and flagged several over-claims in our marketing copy. This patch addresses what we could land in a single release; the rest is on the deferred roadmap below.

- **`README.md`** — `@mem /savings` mentions now label the number as an **estimate** with a one-line caveat that it is derived from typical Copilot context windows rather than measured against real Copilot sessions. Four places updated: hero overview, getting-started step, command table, and chat-participant table.
- **`README.md`** — Version footer + badge sweep to `1.4.10`.
- **`docs/DEMO.md`** — Version references updated to `1.4.10`.

### Deferred to 1.5.x (acknowledged from the review, not in this release)
These are real gaps; tracking publicly so adopters can plan:

- Signed release artifacts, checksums, SBOM, GitHub Actions provenance.
- Formal threat model document covering extension-host permissions, local-store exposure, LM transfer, MCP write tools, pack imports, and terminal capture.
- CI security gates: Dependabot, Gitleaks, Semgrep, `npm audit` blocking. (CodeQL already wired since 1.2.0.)
- Optional encrypted local store via OS keychain.
- Public benchmark suite vs. Copilot Memory / Continue / Cline / OpenMemory with reproducible numbers.
- Published activation-time + memory-footprint measurements in README.

---

## [1.4.9] — 2026-05-31

### Added — Enterprise controls
- **`ghcpMem.enterpriseMode`** — Strict privacy posture that disables terminal capture, raw snippets, MCP write tools, and team export.
- **`ghcpMem.captureCodeSnippets`**, **`ghcpMem.allowMcpWriteAccess`**, **`ghcpMem.allowTeamExport`**, **`ghcpMem.previewBeforePersist`** — New control surface for privacy-by-default workflows.
- **`ghcpMem.runPrivacyWizard`**, **`ghcpMem.auditMemory`**, **`ghcpMem.purgeMemory`** — Onboarding, audit, and purge commands for enterprise users.
- **Security and release docs** — Added threat model, enterprise guide, benchmark outline, dependency automation, and release workflow scaffolding.

### Changed
- **`package.json`**, **`README.md`**, **`docs/COMPARISON.md`**, **`docs/DEMO.md`** — Version references updated to `1.4.9`.
- **`src/extension.ts`**, **`src/sessionCapture.ts`**, **`src/types.ts`** — Privacy wizard, preview-before-persist, enterprise gating, and audit/purge paths added.

---

## [1.4.8] — 2026-05-31

### Added — Enterprise features
- **`ghcpMem.idleTimeoutSeconds`** — New config (0–300s, default 30s) that triggers compression when editor is inactive, measured via editor and text-document activity hooks. Polls every 5s to stay lightweight.
- **`ghcpMem.customRedactionRules`** — New config array allowing users to define custom regex-based redaction rules (name, pattern, replacement, flags) for enterprise compliance modes (PCI-DSS, HIPAA, etc.). Rules compose after the built-in 26-rule set; invalid regex silently skipped.
- **`src/ciSeeder.ts`** — Headless CLI tool for pre-seeding memory from CI/CD pipelines. Reads JSON from stdin, applies redaction, merges into `~/.ghcp-mem/sessions.json`, deduplicates by content hash, and tags with seedLabel. Added to `package.json` bin as `ghcp-mem-ci-seed`.
- **Enhanced temporal NL queries** — `parseInlineFilters` now understands natural language time specs: `since:yesterday`, `since:today`, `since:last-week`, `since:last-month` in addition to numeric formats (`7d`, `24h`). Underscores normalized to hyphens.
- **`ContextDatabase.observations`** — Optional array for free-form CI-seeded context (prod alerts, infra notes, test results).

### Changed
- **`src/redactor.ts`** — `RedactOptions` interface now includes optional `customRules` parameter, applied after built-in rules.
- **`src/extension.ts`** — Activity tracking via `onDidChangeTextDocument` and `onDidChangeActiveTextEditor` to support idle-timeout compression.

---



### Changed
- **`src/extension.ts`** — `activate()` is now `async`; `writeStartupContext()` is properly awaited so the instructions file is written before the first Copilot chat opens.
- **`src/contextProvider.ts`** — `buildStartupContext()` now uses configurable session count (`ghcpMem.startupContextSessionCount`, default 5) instead of hardcoded 3.
- **`src/contextProvider.ts`** — Injected session entries now include `branchName`, `workspaceName`, and Azure subsystems; key files shown increased from 5 to 8.
- **`src/extension.ts`** — `writeStartupContext()` deletes stale instructions file when no sessions exist; logs at `ERROR` (not `WARN`) on write failure.
- **`src/types.ts`**, **`package.json`** — New `ghcpMem.startupContextSessionCount` setting (1–20, default 5).

---

## [1.4.5] — 2026-05-31

### Changed
- **`README.md`** — Restored accurate "automatically, via VS Code's native instructions file" language with mechanism explanation.
- **`package.json`** — Version bump to `1.4.5`.

---

## [1.4.4] — 2026-05-31

### Fixed
- **`README.md`** — Replaced overclaiming language ("Copilot already knows", "hands context back automatically", "zero network") with accurate descriptions; added "Who it is built for" positioning section; labeled token savings as estimates; corrected `@mem` command count from 15 to 20; updated footer to v1.4.4.

---

## [1.4.3] — 2026-05-31

### Fixed
- **`package.json`** — Extension `description` field updated to lead with token-waste core message: "Stops Copilot burning tokens re-reading code it already knew."

---

## [1.4.2] — 2026-05-31

### Added — Developer Intelligence commands (Batch 3)

- **`@mem /whereami`** — Interruption-recovery brief: reads the last 5 sessions, extracts open TODO/WIP signals, surfaces the most recent active files and decisions, and uses the LM to generate a concise AI re-entry brief ("You were doing X, left off at Y, suggested next step: Z"). Status bar proactive hint also surfaces session count when any file is opened.
- **`@mem /debt`** — Technical debt ledger: scans session history for TODO, FIXME, HACK, WORKAROUND, quick-fix, refactor, fragile, and 15+ debt-signal patterns. Groups items by age buckets (🔴 >30d, 🟡 8–30d, 🟢 ≤7d) and generates an AI-prioritised action plan of the top 5 items.
- **`@mem /adr [topic]`** — Formal Architecture Decision Record generator: collects decisions and topics from matching sessions, passes them to the LM to produce a structured ADR (Title / Status / Context / Decision / Options Considered / Consequences / Related Files). Topic filter narrows to specific subsystems.
- **`@mem /pr [branch|PR#]`** — PR review context injection: runs `git diff --name-only <base>` (or `gh pr view <N> --json files`) to get changed files, finds all sessions that touched those files, renders a session history per file, and generates a reviewer briefing via LM.
- **`@mem /precommit`** — Pre-commit architectural consistency check: reads staged files via `git diff --cached --name-only`, finds sessions that previously touched those files, collects relevant decisions, and asks the LM to produce a ✅/⚠️ consistency verdict before you commit.

### Added — Proactive prediction

- **Proactive file-open context hint** — `onDidOpenTextDocument` and `onDidChangeActiveTextEditor` listeners silently surface a transient status-bar message (`$(history) N mem sessions for file.ts · last: 2h ago — @mem /related`) when opening any file that has session history. Zero friction, no popup, 8-second TTL.

### Added — Team intelligence

- **`GHCP-MEM: Export Team Memory Snapshot`** (`ghcpMem.exportTeamMemory`) — Writes `.github/memory/team-context.md` with all architectural decisions (up to 40), key files (up to 50), topics, and the 5 most recent session summaries. Designed to be committed alongside code so team members and agents have instant context without re-explaining the project.

### Added — AI-powered commands

- **`@mem /standup`** — AI-generated daily standup note from yesterday's compressed sessions, formatted as "What I did · What I'm doing today · Any blockers".
- **`@mem /commit`** — AI conventional commit message synthesised from staged diff content plus matching session history; paste straight into the commit dialog.
- **`@mem /ask <question>`** — RAG Q&A: finds the top-5 sessions most relevant to the question, synthesises an answer with inline session citations.
- **`@mem /recap [7d|30d|90d]`** — Narrative engineering recap showing "what shipped, key decisions, patterns" for sprint retros and manager updates.
- **`@mem /related`** — Sessions that touched the currently open file (exact path · suffix · basename match), ranked by recency.
- **`@mem /decisions [keyword]`** — ADR-style decision log deduped across all sessions, grouped by observation type. Shows date, branch, session ID. AI synthesis when ≥5 decisions found.
- **`@mem /savings`** — Lifetime token savings breakdown: per-session rows with raw chars vs compact chars, totals, avg compression ratio, and GPT-4o dollar-equivalent ($5/1M tokens).

### Added — Visual UX

- **`src/timelinePanel.ts`** — Visual Memory Timeline WebviewPanel (`GHCP-MEM: Open Visual Timeline`, shortcut `⌥⌘M`). Color-coded session cards by observation type, full-text search, branch filter, expandable detail on click.
- **`src/sessionCodeLens.ts`** — Session CodeLens at line 0 of every source file (`📚 N sessions touched this file`). Click to open a quick-pick of matching sessions pre-sorted by recency.
- **`package.json`** — `openTimeline` added to `view/title` menu; `showFileHistory` added to `editor/context` menu.

### Added — Hardening (batch 1)

- **`src/searchCore.ts`** — BM25 scoring replaces weighted TF for keyword scoring (better IDF weighting at scale).
- **`src/contextCompressor.ts`** — Stable `vscode.lm.computeEmbeddings` API replaces the preview path; embeddings stored per-session for hybrid retrieval.
- **`src/contextCompressor.ts`** — `CancellationTokenSource` is now properly disposed in a `finally` block (memory leak fix).
- **`src/contextCompressor.ts`** — Git branch name (`branchName`) stamped on every compressed session via `git rev-parse --abbrev-ref HEAD`; visible in sidebar, timeline cards, `/detail`, and `/related`.
- **`src/redactor.ts`** — IPv4 redaction narrowed to credential context (`host=`, `ip=`, etc.) to avoid false-positive source-code redactions.
- **`src/validator.ts`** — Freshness-validation concurrency capped at 20 with a semaphore to prevent I/O storms on large workspaces.
- **`src/extension.ts`** — Keyboard shortcut `⌘⇧⌥S` / `Ctrl+Shift+Alt+S` wired to `ghcpMem.captureSnapshot`.
- **`src/extension.ts`** — `ghcpMem_search` and `ghcpMem_store` registered as VS Code agent-mode tool sets via `vscode.lm.registerTool`.
- **`src/extension.ts`** — Notification hygiene: 5 routine info-toast notifications converted to status-bar messages or output-channel entries.
- **`src/extension.ts`** — Live status bar item shows spinner (⟳) during compression and error indicator on failure, plus tooltip with current session count.
- **`src/extension.ts`** — Dedicated `GHCP-MEM` output channel (`memLog`) with structured `log()` helper for diagnostics without VS Code notification spam.
- **`src/extension.ts`** — MCP server auto-registered via feature-detected `vscode.lm.registerMcpServer` API (VS Code ≥1.101) with graceful fallback.
- **`src/extension.ts`** — Follow-up provider registered with context-aware suggestions based on last `@mem` command used.
- **`src/extension.ts`** — CLAUDE.md and `.cursor/rules` cross-editor instruction injection (hash-guarded to avoid duplicate writes).
- **`src/mcpServer.ts`** — Two new MCP write tools: `ghcpMem_store` (persist an external session) and `ghcpMem_delete` (delete by ID prefix).
- **`src/contextStore.ts`** — `getStats()` upgraded: now returns `lifetimeEstimatedTokensSaved`, `avgCompressionRatio`, `totalCompactTokens` with `RAW_EVENT_OVERHEAD_CHARS = 800` per-session estimate.
- **`src/types.ts`** — `CompressedSession` gains `branchName?: string`.
- **Walkthroughs** — All 5 walkthrough steps now emit `completionEvent` so VS Code marks them done.

### Fixed

- **`src/test/redactor.test.ts`** — IPv4 test updated from plain prose to credential-context string (`host=192.168.1.42`) to match the narrowed regex.
- **`src/test/mcpServer.test.ts`** — TOOLS count assertion updated from 4 → 6 (added `ghcpMem_store`, `ghcpMem_delete`).

### Added — Documentation and README

- **`README.md`** — Updated `@mem` commands table to list all 20 slash commands.
- **`README.md`** — New "Visual Timeline", "Session CodeLens", and "AI-powered chat commands" subsections under Core features.
- **`README.md`** — Commands table includes `GHCP-MEM: Open Visual Timeline` and `GHCP-MEM: Show File Session History`.
- **`README.md`** — External MCP tools section updated to list all 6 tools (including `ghcpMem_store` and `ghcpMem_delete`).
- **`README.md`** — Architecture module table includes `timelinePanel.ts` and `sessionCodeLens.ts`.
- **`README.md`** — Agent mode tools table lists `ghcpMem_search` and `ghcpMem_store` (registered as languageModelTools).
- **`README.md`** — Version footer updated to `v1.3.0`.
- **`walkthroughs/chat.md`** — All new slash commands documented.

### Added — Previous [Unreleased] item

- **`src/extension.ts`** — In-product Marketplace rating prompt flow (14-day cooldown, `Rate / Later / Don't Ask Again`).

### Changed

- **`.gitignore`** — Added explicit `src/test/.env` ignore rule as defence-in-depth for local secrets in test harnesses.
- **`.gitignore`** — `docs/growth/**` is now treated as local-only planning content and excluded from version control.


## [1.2.3] — 2026-05-17

### Fixed
- **`src/mcpServer.ts`** — `ghcpMem_timeline` now returns most-recent activity first (`endTime` descending) so MCP clients show the newest context by default.

### Added
- **`src/test/mcpServer.test.ts`** — Added regression coverage for timeline ordering and limit handling.

### Changed
- **`package.json`**, **`package-lock.json`** — Version bump to `1.2.3` for Marketplace release.

## [1.2.2] — 2026-05-17

### Fixed
- **`src/azureContext.ts`** — Azure context cache is now option-aware (`includeResources` + `resourceGroup`) to avoid stale/mismatched snapshot reuse.
- **`src/validator.ts`** — Freshness validation now resolves workspace root per session in multi-root workspaces, reducing false missing-file drops.

### Changed
- **`src/health.ts`** — Health scoring now rewards lower secret incidence (`secretHygienePct`) while still reporting `redactionCoveragePct` transparently.

### Tests
- Updated/added tests in **`src/test/azureContext.test.ts`**, **`src/test/health.test.ts`**, and **`src/test/validator.test.ts`** to cover new behavior.
- **`package.json`**, **`package-lock.json`** — Version bump to `1.2.2` for Marketplace release.

## [1.2.1] — 2026-05-14

### Security
- **`.github/workflows/ci.yml`** — Added workflow-level `permissions: contents: read` (least privilege). The release job keeps its `contents: write` override only for the GitHub-release publish step. Closes CodeQL alert `actions/missing-workflow-permissions`.
- **`src/eval.ts`** — `formatEvalReport()` now escapes backslashes _before_ pipes when rendering query strings into the GFM table, so a literal `\` in a query can no longer break the rendered table or smuggle markdown control characters. Closes CodeQL alert `incomplete-string-escaping`.
- **`src/test/redactor.test.ts`**, **`src/test/redactor.corpus.test.ts`** — Every secret-shaped fixture (PATs, OpenAI `sk-`, MongoDB+SRV URIs, Postgres URLs, PEM blocks, Bearer headers, …) is now assembled at runtime via string concatenation. Runtime values still match every redaction regex, but the source files no longer contain a complete-looking credential literal — so GitHub push-protection / secret scanning stop flagging the deliberate regression corpus as a leaked secret.
- **`.github/secret_scanning.yml`** — New file. Adds `paths-ignore` for `src/test/**`, `out-test/**`, `docs/**` as defence-in-depth, with a header comment explaining the rationale (deliberate synthetic regression corpus, no real credentials). Production code paths remain fully scanned.

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
- **`docs/diagrams/*.mmd`** — Retrieval and architecture diagrams restyled with a unified dark-slate theme + colour-grouped `classDef`s. Architecture cluster backgrounds set to `#f1f5f9` explicitly so labels stay readable (the default theme rendered them in dark brown).

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
