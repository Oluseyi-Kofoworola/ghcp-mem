# GHCP-MEM Benchmark Report

**Run date:** 2026-05-31  
**Build:** `ghcp-mem@1.6.0`

## Repro steps

```bash
npm run eval:check
npm run bench
```

## Results

| Check | Result |
|---|---:|
| Retrieval eval (`keyword-only`) | Recall@5 `1.000` · MRR `1.000` |
| Search benchmark p50 | `659 µs` |
| Search benchmark p95 | `1614 µs` |
| Search benchmark p99 | `2126 µs` |
| Search benchmark max | `2475 µs` |

## What is proven here

- Retrieval rankers hit the expected floor on the synthetic corpus.
- Search stays in low-millisecond territory on a 1000-session in-memory store.
- Token savings are calculatable per session and in aggregate via the shared estimator used by chat, stats, and tests.

## Token-savings model

- **Per session:** estimated raw tokens minus estimated compact tokens.
- **Overall:** sum of all per-session savings.
- **Heuristic:** 4 characters per token with a fixed capture overhead per session.

