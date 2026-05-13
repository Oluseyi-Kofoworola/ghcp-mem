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

  // Preferred (proposed) API surface: vscode.lm.computeEmbeddings({ model, inputs })
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
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
