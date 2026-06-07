# Baton Benchmarks

## Measured areas

- Retrieval accuracy
- Recall@5
- MRR
- Stale-memory rejection rate
- Redaction accuracy
- Token reduction estimate
- Search latency
- Activation time
- Extension host memory usage

## Benchmark posture

Results should come from a fixed sample repository set and repeatable tasks. Claims should be reported as measured values or clearly labeled estimates.

See the current sample results in [BENCHMARK_REPORT.md](./BENCHMARK_REPORT.md).

## Token-savings estimator

- Per-session savings = estimated raw tokens captured for the session minus estimated compact tokens stored in the summary.
- Overall savings = sum of all per-session savings across the selected session set.
- The estimator uses the same 4-chars-per-token heuristic and fixed capture overhead everywhere in the product, so chat output, stats, and benchmarks stay aligned.
