# AGENTS.md — Baton

VS Code extension that gives Copilot a **local-first, auditable session-memory layer**. Also ships a stand-alone MCP stdio server (`baton-mem-mcp`) and a CI seeder (`baton-mem-ci-seed`).

For full dev setup, CI gates, and PR process, read [CONTRIBUTING.md](CONTRIBUTING.md) first. This file only captures what an AI agent needs beyond that.

## Build / test / run

```bash
npm install            # no native deps — must succeed on any OS without build tools
npm run watch          # incremental TS build to out/
npm test               # Node built-in test runner via scripts/run-tests.mjs (300+ tests)
npm run lint           # ESLint
npx tsc --noEmit       # type-check only
npm run bundle:prod    # esbuild production bundle (CI gate)
```

Press `F5` in VS Code to launch the Extension Development Host.

Run a single test file: `npx mocha --require ts-node/register src/test/<name>.test.ts`.

## Architecture map

Entry points and module ownership are listed in [CONTRIBUTING.md §2](CONTRIBUTING.md#2-project-structure). Key boundaries:

- [src/extension.ts](src/extension.ts) — activation, command registration, walkthroughs. Keep activation cheap (`onStartupFinished`).
- [src/contextProvider.ts](src/contextProvider.ts) — `@mem` chat participant + all slash commands (`/search`, `/entity`, `/why`, `/lineage`, `/route`, `/compliance`, …).
- [src/contextStore.ts](src/contextStore.ts) — persistent storage, indexing, eviction, backups. All writes go through here.
- [src/contextCompressor.ts](src/contextCompressor.ts) — LM compression. **Evidence-citation gate**: a decision cannot be emitted without pointing at the captured event that produced it. Do not weaken this.
- [src/searchCore.ts](src/searchCore.ts) — BM25 + RRF + recency. Guarded by an nDCG@K regression gate in CI (`scripts/eval-check.js`).
- [src/redactor.ts](src/redactor.ts) — 24-rule secret/PII redaction. **Every new capture path must pipe through this before persistence.**
- [src/mcpServer.ts](src/mcpServer.ts) — stdio MCP server. Schema is asserted in tests (`mcpServerSchema.test.ts`); update both when changing tool surface.
- `out/` is committed-by-build, not by hand — never edit compiled JS in `out/` or `out-test/`.

## Project-specific rules (these differ from common practice)

- **No native dependencies.** `npm install` must not compile anything. Reject deps with `node-gyp`, prebuilt binaries, or postinstall scripts.
- **No open ports, no daemon.** Communication is VS Code IPC or stdio only. Do not add HTTP servers, sockets, or background processes.
- **Redact first.** Anything captured from terminal, chat, editor, or git must pass through `redactor.ts` before it reaches `contextStore`.
- **TypeScript strict.** No `any`, no `!` non-null assertions without justification.
- **Tests are required for new modules.** Mocks for the VS Code API live in `src/test/__mocks__/vscode.ts` — tests must not require a running VS Code instance.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **Comments only when WHY is non-obvious.** Do not add docstrings/comments to code you didn't change.

## CI gates that block merge

Listed in [CONTRIBUTING.md §4](CONTRIBUTING.md#4-ci-gates). Summary: lint, tests, `scripts/eval-check.js` (retrieval recall@5 + MRR, >5% regression fails), `scripts/bench-search.js` (search p99 < 50ms), `scripts/smoke.js`, `npm run bundle:prod`, `vsce package` clean.

## Pitfalls

- Editing `out/` or `out-test/` instead of `src/` — those are build output.
- Windows-only path bugs: this extension targets all OSes; use `path.join`, never hard-code separators.
- The `CLAUDE.md` file's `<!-- Baton:START -->` block is auto-injected by the extension itself — do not hand-edit that region.
- Bumping `version` in [package.json](package.json) without running `node scripts/check-release-consistency.mjs` will fail CI.
