/**
 * Co-occurrence-based query expansion.
 *
 * Given the user's original query terms and the corpus of stored sessions,
 * walk the inverted index to find terms that frequently co-occur with the
 * query terms but are NOT already in the query. Return the top-N as
 * suggested expansions.
 *
 * Example: query `"postgres"` over a corpus where every `postgres` session
 * also mentions `pool` and `connection` will yield expansions
 * `["pool", "connection"]`. Adding those at retrieval time recovers
 * matches that pure BM25 would miss when the user phrases their query
 * differently from how they originally captured the work.
 *
 * Cheap: works from the inverted index already maintained by ContextStore.
 * No LM calls, no network, deterministic given the corpus.
 */

/**
 * Map of term → set of session IDs that contain that term. Caller is
 * expected to pass the same `index` shape ContextStore uses internally.
 */
export type InvertedIndex = Map<string, Set<string>>;

export interface ExpandQueryOptions {
  /** How many additional terms to return. Default: 3. */
  maxExpansions?: number;
  /**
   * Minimum number of original-query sessions a candidate expansion must
   * appear in. Prevents one-off coincidental co-occurrences from leaking
   * into the expanded query. Default: 2 (or 1 when only one session matches).
   */
  minCoOccurrence?: number;
  /**
   * Cap on the total number of sessions an expansion candidate may appear
   * in across the entire corpus. Filters out generic stopword-ish terms
   * that show up everywhere (e.g. "session", "file", "code"). Expressed
   * as a fraction of total session count. Default: 0.5.
   */
  maxGlobalFrequency?: number;
}

export function expandQuery(
  terms: Set<string>,
  index: InvertedIndex,
  totalSessions: number,
  opts: ExpandQueryOptions = {},
): string[] {
  const maxExpansions = opts.maxExpansions ?? 3;
  const requestedMin = opts.minCoOccurrence ?? 2;
  const maxGlobalFrequency = opts.maxGlobalFrequency ?? 0.5;
  if (terms.size === 0 || index.size === 0 || totalSessions === 0) return [];

  // Find the universe of session IDs that hit at least one query term.
  const seedSessionIds = new Set<string>();
  for (const t of terms) {
    const hits = index.get(t);
    if (hits) for (const id of hits) seedSessionIds.add(id);
  }
  if (seedSessionIds.size === 0) return [];

  // If only one seed session matched, we can't compute a co-occurrence
  // threshold meaningfully — soften the minimum to 1.
  const minCoOccurrence = seedSessionIds.size === 1 ? 1 : requestedMin;

  // For every term in the index, count how many seed sessions it appears in.
  // We deliberately walk the full index here: it's a Map<string, Set<string>>
  // so the cost is O(unique_terms × avg_set_size) — bounded by the corpus.
  const scored: Array<{ term: string; coOccur: number; globalFreq: number }> = [];
  for (const [term, hits] of index) {
    if (terms.has(term)) continue; // skip terms already in the query
    if (hits.size / totalSessions > maxGlobalFrequency) continue; // too generic
    let coOccur = 0;
    for (const id of seedSessionIds) if (hits.has(id)) coOccur++;
    if (coOccur < minCoOccurrence) continue;
    scored.push({ term, coOccur, globalFreq: hits.size });
  }

  // Sort by co-occurrence desc, then by lower globalFreq (rarer = more
  // discriminative). Stable tie-break by term name for determinism.
  scored.sort(
    (a, b) => b.coOccur - a.coOccur || a.globalFreq - b.globalFreq || a.term.localeCompare(b.term),
  );
  return scored.slice(0, maxExpansions).map((s) => s.term);
}
