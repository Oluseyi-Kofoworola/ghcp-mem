import * as vscode from 'vscode';

/**
 * Context-pressure autosave trigger.
 *
 * VS Code does not expose live context-window usage to extensions today, so
 * we proxy "pressure" with two signals:
 *
 *   1. eventCount     — how many captured events sit unflushed.
 *   2. wallClockMinutes — how long since the last flush.
 *
 * Either threshold being exceeded fires a compression. This mimics the
 * behaviour of Cortex / claude-mem's 80-95% context autosave without needing
 * the actual token-count signal.
 */
export interface AutosaveOptions {
  eventThreshold: number;
  minutesThreshold: number;
  getEventCount: () => number;
  onTrigger: (reason: 'events' | 'minutes') => Promise<void>;
  /** Polling interval in ms. Default 30s. */
  pollIntervalMs?: number;
}

export class AutosaveTrigger implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private lastFlushAt = Date.now();
  private firing = false;

  constructor(private readonly opts: AutosaveOptions) {}

  start(): void {
    if (this.timer) return;
    const poll = Math.max(5_000, this.opts.pollIntervalMs ?? 30_000);
    this.timer = setInterval(() => this.tick().catch(() => {}), poll);
  }

  notifyFlushed(): void {
    this.lastFlushAt = Date.now();
  }

  private async tick(): Promise<void> {
    if (this.firing) return;
    const events = this.opts.getEventCount();
    const minutesSince = (Date.now() - this.lastFlushAt) / 60_000;

    let reason: 'events' | 'minutes' | undefined;
    if (events >= this.opts.eventThreshold) reason = 'events';
    else if (events > 0 && minutesSince >= this.opts.minutesThreshold) reason = 'minutes';

    if (!reason) return;

    this.firing = true;
    try {
      await this.opts.onTrigger(reason);
      this.lastFlushAt = Date.now();
    } finally {
      this.firing = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
