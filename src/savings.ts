export interface TokenSavingsSource {
  summary?: string;
  keyFiles?: string[];
  keyTopics?: string[];
  decisions?: string[];
  problemsSolved?: string[];
}

export interface TokenSavingsEstimate {
  rawChars: number;
  compactChars: number;
  rawTokens: number;
  compactTokens: number;
  tokensSaved: number;
  compressionRatio: number;
}

export interface TokenSavingsAggregate extends TokenSavingsEstimate {
  sessionCount: number;
}

const DEFAULT_RAW_EVENT_OVERHEAD_CHARS = 800;
const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function sessionChars(session: TokenSavingsSource): { rawChars: number; compactChars: number } {
  const compactChars = (session.summary ?? '').length;
  const rawChars =
    [
      session.summary ?? '',
      ...(session.keyFiles ?? []),
      ...(session.keyTopics ?? []),
      ...(session.decisions ?? []),
      ...(session.problemsSolved ?? []),
    ].join(' ').length + DEFAULT_RAW_EVENT_OVERHEAD_CHARS;
  return { rawChars, compactChars };
}

export function estimateSessionTokenSavings(session: TokenSavingsSource): TokenSavingsEstimate {
  const { rawChars, compactChars } = sessionChars(session);
  const rawTokens = estimateTokens(rawChars);
  const compactTokens = estimateTokens(compactChars);
  const ratio = compactChars > 0 ? rawTokens / Math.max(compactTokens, 1) : 1;
  return {
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: Math.max(0, rawTokens - compactTokens),
    compressionRatio: Math.round(ratio * 10) / 10,
  };
}

export function aggregateTokenSavings(sessions: TokenSavingsSource[]): TokenSavingsAggregate {
  const totals = sessions.reduce(
    (acc, session) => {
      const estimate = estimateSessionTokenSavings(session);
      acc.rawChars += estimate.rawChars;
      acc.compactChars += estimate.compactChars;
      acc.rawTokens += estimate.rawTokens;
      acc.compactTokens += estimate.compactTokens;
      acc.tokensSaved += estimate.tokensSaved;
      return acc;
    },
    {
      rawChars: 0,
      compactChars: 0,
      rawTokens: 0,
      compactTokens: 0,
      tokensSaved: 0,
    },
  );

  return {
    ...totals,
    sessionCount: sessions.length,
    compressionRatio:
      totals.compactTokens > 0
        ? Math.round((totals.rawTokens / Math.max(totals.compactTokens, 1)) * 10) / 10
        : 1,
  };
}

export function estimateTokenSavingsUsd(tokensSaved: number, pricePerMillionTokens = 5): number {
  return (tokensSaved * pricePerMillionTokens) / 1_000_000;
}
