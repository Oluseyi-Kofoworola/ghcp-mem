/**
 * Shared execution context passed to every extracted `@mem` command handler.
 *
 * Phase 2 of the contextProvider.ts decomposition moves command handlers out of
 * the provider class into per-group modules (./generation, ./retrieval, …).
 * Those free functions can't reach the class's private members, so the small,
 * explicit surface they actually need is captured here. `ContextProvider`
 * implements this interface and passes `this` when dispatching.
 */
import * as vscode from 'vscode';
import { ContextStore } from '../contextStore';

export interface CommandContext {
  /** The single persistent session store all handlers read/write through. */
  readonly store: ContextStore;

  /**
   * Stream a language-model completion for `prompt` into the chat response.
   * Centralised so every generation command shares identical error handling.
   */
  streamLm(
    prompt: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void>;
}
