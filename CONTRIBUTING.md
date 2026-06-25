# Contributing to GHCP-MEM

Thank you for your interest in contributing! This guide covers everything you need to get a dev build running, the project conventions, and the PR process.

---

## Table of contents

1. [Dev setup](#1-dev-setup)
2. [Project structure](#2-project-structure)
3. [Running tests](#3-running-tests)
4. [CI gates](#4-ci-gates)
5. [Coding conventions](#5-coding-conventions)
6. [Submitting a PR](#6-submitting-a-pr)
7. [Reporting bugs](#7-reporting-bugs)

---

## 1. Dev setup

**Prerequisites:**
- Node.js 20+
- VS Code 1.95+ (for the extension host)
- Git

```bash
git clone https://github.com/ITcredibl/ghcp-mem.git
cd ghcp-mem
npm install
```

**Compile and watch:**

```bash
npm run watch          # incremental build in watch mode
```

**Launch the extension in a VS Code Extension Development Host:**

- Open the repo in VS Code
- Press `F5` (or Run → Start Debugging)
- A new VS Code window opens with the extension loaded from `out/`

---

## 2. Project structure

| Path | Purpose |
|---|---|
| `src/extension.ts` | Entry point — lifecycle, commands, walkthroughs |
| `src/contextProvider.ts` | `@mem` chat participant and all slash commands |
| `src/contextStore.ts` | Persistent storage, indexing, eviction, backups |
| `src/contextCompressor.ts` | LM compression and git branch tagging |
| `src/searchCore.ts` | BM25 + RRF + recency scoring |
| `src/redactor.ts` | 26-rule secret/PII redaction |
| `src/mcpServer.ts` | Stand-alone stdio MCP server (14 tools) |
| `src/timelinePanel.ts` | Visual Memory Timeline WebviewPanel |
| `src/sessionCodeLens.ts` | Inline file-history CodeLens |
| `src/validator.ts` | Codebase freshness validation |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/test/` | Mocha/Node test suite |
| `scripts/` | CI eval, bench, smoke, and bundle scripts |

---

## 3. Running tests

```bash
npm test                  # full test suite (138 tests)
npm run lint              # ESLint
npx tsc --noEmit          # type-check without emitting
```

To run a single test file:

```bash
npx mocha --require ts-node/register src/test/contextStore.test.ts
```

The test suite uses **Node's built-in test runner** (no Jest/Vitest). Tests do **not** require a running VS Code instance — they mock the VS Code API via `src/test/__mocks__/vscode.ts`.

---

## 4. CI gates

Every PR runs the following pipeline on `ubuntu-latest`, `windows-latest`, and Node 20:

```
npm run lint
npm test
node scripts/eval-check.js     # recall@5 + MRR must not drop > 5%
node scripts/bench-search.js   # search must stay < 50ms p99
node scripts/smoke.js          # extension activates without errors
npm run bundle:prod            # esbuild production bundle
vsce package                   # .vsix must build without warnings
```

PRs that break any gate will not be merged.

### Run every gate locally before pushing

```
npm run verify        # format:check + lint + typecheck + test + check:release + eval:check + bench + bundle:prod
```

`npm run verify` runs the full gate set in one shot, so you reproduce CI before
you push. To catch the cheapest slips (formatting, lint) automatically, install
the opt-in git hook once:

```
npm run hooks:install   # adds a pre-commit hook running format:check + lint
```

The hook is dependency-free and never installs on `npm install` (the project
forbids postinstall scripts). Bypass a single commit with `git commit --no-verify`.

---

## 5. Coding conventions

- **TypeScript strict mode** — no `any`, no `!` non-null assertions without justification
- **No native dependencies** — the extension must work on any OS without build tools
- **No open ports** — all communication is VS Code IPC or stdin/stdout
- **Redact first** — any new capture path must run through `redactor.ts`
- **Tests required** — new modules need at least one unit test
- **Comments** — only for non-obvious logic; avoid noise comments
- **Commit messages** — conventional commit format: `feat:`, `fix:`, `docs:`, `chore:`, `test:`

---

## 6. Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes and ensure all gates pass locally
3. Open a PR against `main` with:
   - A clear description of **what** changed and **why**
   - References to any related issues (`Closes #123`)
   - Test coverage for new behaviour
4. A maintainer will review within a few days

For significant changes, open an issue first to discuss the approach.

---

## 7. Reporting bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template. Include:

- VS Code version (`Help → About`)
- GHCP-MEM version (Extensions sidebar)
- Steps to reproduce
- What you expected vs what happened
- Relevant output from the `GHCP-MEM` output channel (`View → Output → GHCP-MEM`)

---

## Code of conduct

Be respectful. Contributions of all experience levels are welcome.
