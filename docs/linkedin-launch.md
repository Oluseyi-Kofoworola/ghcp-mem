# LinkedIn launch — GHCP-MEM v1.2.0

Two drafts: a long-form **article** (~1100 words) and a short-form **feed post** (~280 words).
Edit freely before publishing.

---

## Long-form article (LinkedIn Articles / Pulse)

**Title:** Why I Built Persistent Memory for GitHub Copilot — And What It Taught Me About AI Pair Programming

---

Three weeks ago, I asked GitHub Copilot the same question for what felt like the hundredth time:

> *"Why did we choose Redis over Memcached for the session cache again?"*

Copilot, brilliant as it is, had no idea. Not because the answer wasn't in our codebase — it absolutely was, buried in a Slack thread, a closed PR, and a since-deleted ADR. But Copilot lives a goldfish's life. Every chat starts at zero. Every "we already discussed this" gets a confident, well-formatted, *wrong* answer.

So I built **GHCP-MEM** — a VS Code extension that gives Copilot a memory.

This week it shipped v1.2.0. Here's what makes it different, what it taught me, and why I think persistent context is the missing layer of every AI coding assistant on the market.

---

### The problem isn't intelligence. It's amnesia.

Modern LLM coding assistants are extraordinary at *reasoning*. Drop them into a fresh repo and watch them refactor a thousand-line module before you've finished your coffee.

But ask one to remember that you decided last Tuesday to skip retries on the auth endpoint because the upstream IDP gets angry — and you're back to square one. The model can read your code. It cannot read your *decisions*.

That gap — between "what the code says" and "what the team decided" — is where every senior engineer earns their salary. It's also where AI assistants quietly fail every single day.

---

### What GHCP-MEM actually does

GHCP-MEM is a VS Code extension that runs alongside Copilot and silently compresses every meaningful coding session into a **structured memory record** — summary, key files, decisions, problems solved, topics. Those records are stored locally (yours, on your disk, never uploaded) and exposed back to Copilot through three channels:

1. **A chat participant** (`@mem`) — `@mem recent`, `@mem search redis`, `@mem export <id>`, `@mem timeline`. Conversational recall.
2. **Language Model tools** — `ghcpMem_search` and `ghcpMem_store` are auto-discovered by Copilot's tool registry, so Copilot can *decide* to consult memory when it thinks it needs to. No prompt engineering required.
3. **A stdio MCP server** — pipes the same memory into any MCP-compatible client (Claude Desktop, Cursor, Cline, you name it). Memory becomes a platform primitive, not a Copilot-only feature.

It is the only memory plugin I know of that does all three at once.

---

### Three things that surprised me while building it

**1. Retrieval is harder than people pretend.**

Everyone slaps a vector DB on a problem and calls it "RAG." Then they get mediocre results and blame the embedding model.

The truth is: a 1 000-row personal memory store doesn't need a vector database — it needs **disciplined hybrid ranking**. GHCP-MEM combines a hand-rolled inverted index, recency boosts, and (optionally) local embeddings through *Reciprocal Rank Fusion* with k=60. On a 1 000-session corpus, p95 search latency is **1.25 ms** — that's the entire query path, on a developer laptop, no GPU.

A regression gate runs in CI on every commit: recall@5 and MRR floors with a 5 % tolerance band. Ship a "smarter" ranker that quietly drops recall? CI fails. This is what reliability looks like for retrieval systems and it's basically free to build.

**2. Privacy is a feature, not a checkbox.**

The first version of the redactor caught the obvious things — AWS keys, GitHub PATs, JWTs. Then I ran it against a real workspace and watched it leak an Azure Storage connection string in a comment.

The current version has **21 redaction rules** covering everything from `AKIA…` through PEM private-key blocks, Cosmos DB endpoints, Service Bus SAS tokens, postgres URLs with embedded creds, and Azure SP secrets. There's a 21-fixture corpus test that fails the build if any one regex weakens another — because that's exactly the kind of regression you don't notice until your secret is in a screenshot on Stack Overflow.

A `<private>` tag lets developers mark spans they never want captured. A configurable disk cap (default 25 MB) means the store can't grow unbounded and silently retain something you forgot about. The whole thing is local-first by design — there is no cloud, no sync, no "anonymous telemetry." Your decisions live in `~/.ghcp-mem/` and nowhere else.

**3. The hard part isn't capture. It's compression.**

Recording every keystroke would produce a useless firehose. The trick is asking *Copilot itself* to summarise each session — its own LM endpoint, the same `gpt-4o` you already pay for, with a tight prompt that extracts only the structured fields. The model is generous with summaries when you ask it the right questions. A 45-minute coding session compresses to roughly 600 bytes of structured JSON: summary, 3-5 key files, 1-3 decisions, the problems solved, the topics. Searchable. Diffable. Exportable.

The compression step is what turns 1 000 sessions of activity into a memory you can actually *retrieve* from instead of grep.

---

### What v1.2.0 ships with

- **GitHub-compatible mode** — toggle one setting and GHCP-MEM mirrors GitHub's hosted Copilot memory contract (28-day retention, repo-scoped recall) so you can A/B against the official product.
- **Pinned tier** — sessions you mark `pinned` float above the date groups and survive eviction.
- **Walkthroughs** — three-step onboarding for new users, because nothing kills adoption like a blank sidebar.
- **CI pipeline** — Ubuntu + Windows × Node 20, with lint → typecheck → test → eval-gate → bench → bundle → vsix artifact, automatically attached to GitHub releases on `v*` tags.
- **130 tests** covering the redactor corpus, MCP schema, search ranking, validators, retention, and the size cap.

The extension itself is 82 KB after esbuild. The whole VSIX is 172 KB. It does what a 500 MB Electron app pretends to do.

---

### The bigger idea

We're entering a phase of AI tooling where the **model** is no longer the bottleneck. The bottleneck is **what the model knows about you** — your repo, your decisions, your trade-offs, your team's accumulated context.

Companies will spend the next two years racing to build that context layer. Most of them will build it as a SaaS, charge per seat, and hold your team's history hostage in someone else's database.

GHCP-MEM is my bet that the context layer **doesn't need to be a service**. It needs to be a small, fast, local, redaction-first plugin that any developer can install in 30 seconds and any team can audit in an afternoon.

If that's a future you find interesting, the source is open and the install link is one click away.

---

**Try it:** Search "GHCP-MEM" in the VS Code Marketplace or install with `code --install-extension ghcp-mem`.
**Source:** https://github.com/Oluseyi-Kofoworola/ghcp-mem

If you build with Copilot every day, I'd love your feedback. Especially the uncomfortable kind.

\#GitHubCopilot #DeveloperTools #VSCode #AI #AIEngineering #OpenSource #DeveloperProductivity

---

## Short feed post (LinkedIn timeline, ~280 words)

> GitHub Copilot is brilliant at reasoning. It is also a goldfish.
>
> Every chat starts at zero. Every "we already discussed this" gets a confident, well-formatted, wrong answer. The gap between *what the code says* and *what the team decided* is where senior engineers earn their salary — and where AI assistants quietly fail every day.
>
> So I built **GHCP-MEM**, a VS Code extension that gives Copilot a persistent memory. It just shipped v1.2.0.
>
> What's in the box:
>
> ► Local-first: every session compressed to ~600 bytes of structured JSON and stored on your disk. No cloud. No telemetry.
> ► 21 redaction rules covering AWS, GitHub, Azure Storage / Service Bus / Cosmos / SP secrets, postgres URLs, JWTs, PEM blocks, and more — guarded by a corpus regression test.
> ► Hybrid retrieval: inverted index + recency + optional embeddings fused with RRF. **p95 search latency: 1.25 ms** on 1 000 sessions.
> ► Three surfaces: `@mem` chat participant, `ghcpMem_search` / `ghcpMem_store` LM tools, and a stdio MCP server (so Claude Desktop, Cursor, and Cline get the same memory).
> ► CI-enforced eval gate — recall@5 and MRR floors block any ranker regression at PR time.
> ► 130 tests. 172 KB VSIX. 82 KB extension bundle.
>
> The model isn't the bottleneck anymore. **What the model knows about you** is. And that context layer doesn't need to be a SaaS holding your team's history hostage — it can be a 172 KB plugin you audit in an afternoon.
>
> Try it: `code --install-extension ghcp-mem`
> Source: github.com/Oluseyi-Kofoworola/ghcp-mem
>
> Feedback welcome — especially the uncomfortable kind.
>
> \#GitHubCopilot #DeveloperTools #AI #OpenSource

---

## Suggested cover image for the article

Use `images/demo/pipeline-animation.png` (already in the repo at 38 KB) — gradient banner matches the post's tone. For the short post, an inline screenshot of the sessions tree with a pinned-tier session works well.
