import * as vscode from 'vscode';

/**
 * Embedding helpers — optional hybrid retrieval layer.
 *
 * The VS Code `vscode.lm` embeddings API is still proposed at the time of
 * writing, so everything in this module is feature-detected and guarded with
 * try/catch. If embeddings are unavailable the rest of the extension continues
 * to work on pure keyword + recency (RRF) scoring.
 */

export type EmbeddingFn = (text: string) => Promise<number[] | undefined>;

/**
 * Returns a function that produces a single-vector embedding for `text`, or
 * `undefined` if the API is not available in this VS Code build.
 */
export async function getEmbedder(): Promise<EmbeddingFn | undefined> {
  const lm = vscode.lm as any;
  if (!lm) return undefined;

  // Preferred: stable VS Code ≥1.102 API — computeEmbeddings(model, { inputs })
  if (
    typeof lm.computeEmbeddings === 'function' &&
    typeof lm.selectEmbeddingModels === 'function'
  ) {
    return async (text: string) => {
      try {
        const models: any[] = await lm.selectEmbeddingModels({});
        if (models.length > 0) {
          const res = await lm.computeEmbeddings(models[0], { inputs: [text] });
          const vec = res?.embeddings?.[0]?.values ?? res?.[0]?.values;
          if (Array.isArray(vec)) return vec;
        }
      } catch {
        /* fall through to older shape */
      }
      try {
        const res = await lm.computeEmbeddings({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  // Proposed API surface (pre-1.102): vscode.lm.computeEmbeddings({ model, inputs })
  if (typeof lm.computeEmbeddings === 'function') {
    return async (text: string) => {
      try {
        const res = await lm.computeEmbeddings({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  // Alternate spelling some builds exposed: vscode.lm.embeddings.compute
  if (lm.embeddings && typeof lm.embeddings.compute === 'function') {
    return async (text: string) => {
      try {
        const res = await lm.embeddings.compute({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  return undefined;
}

export function cosineSim(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Dimensionality of the dependency-free local embedding. Kept small (128) so
 * the persisted vector is far cheaper than a neural embedding (typically
 * 768–1536 dims) while still giving the hybrid ranker a dense signal.
 */
export const LOCAL_EMBED_DIM = 128;

/** FNV-1a 32-bit hash → unsigned int. Stable across processes (no Math.random). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in safe-integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic, dependency-free local embedding using the feature-hashing
 * ("hashing trick") approach: each unigram and adjacent-bigram feature is
 * hashed into a fixed-dimension vector with a signed bucket, then the vector
 * is L2-normalised. This is a *lexical* dense embedding — it captures term
 * overlap and limited word-order signal, not learned semantics — but it lets
 * the hybrid cosine-RRF rank in `ContextStore.search()` run by default,
 * offline, with zero native deps and no network. When the proposed
 * `vscode.lm` embeddings API is available, `getEmbedder()` supersedes this
 * with a true neural embedding.
 */
export function localEmbed(text: string, dim = LOCAL_EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const terms = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const addFeature = (feat: string, weight: number) => {
    const h = fnv1a(feat);
    const idx = h % dim;
    const sign = fnv1a(feat + '\u0000sign') & 1 ? 1 : -1;
    vec[idx] += weight * sign;
  };

  for (let i = 0; i < terms.length; i++) {
    addFeature(terms[i], 1);
    if (i + 1 < terms.length) addFeature(terms[i] + '_' + terms[i + 1], 0.5);
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      // Round to 4 decimals to keep the persisted JSON compact.
      vec[i] = Math.round((vec[i] / norm) * 1e4) / 1e4;
    }
  }
  return vec;
}

/**
 * An `EmbeddingFn` backed by `localEmbed`. Always available — used as the
 * default when the neural `vscode.lm` embeddings API is not present, so hybrid
 * dense retrieval works out of the box.
 */
export function makeLocalEmbedder(dim = LOCAL_EMBED_DIM): EmbeddingFn {
  return async (text: string) => localEmbed(text, dim);
}
