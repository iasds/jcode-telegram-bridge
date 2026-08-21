/**
 * Quiet-period batching for incoming Telegram messages (C14 gap item:
 * long-text chunk aggregation + media-group coalescing).
 *
 * Telegram clients split messages longer than 4096 chars into several
 * sequential messages, and photo/album sends arrive as a burst. hermes
 * aggregates such bursts into a single event so the agent is never
 * interrupted mid-turn. This module is the pure, I/O-free logic for that
 * aggregation: per-chat buffers that flush after a quiet period
 * (maxWaitMs) or on demand.
 *
 * Pure TS: no I/O, no telegraf dependency. bridge.ts wires this to the
 * poll loop (push on each incoming message, flush before invoking the
 * harness).
 */

export interface TextBatchOptions {
  /** Longest quiet period before buffered text is flushed (ms). Default 1000. */
  maxWaitMs?: number;
  /**
   * Hard ceiling on a buffer's TOTAL age in ms (P-03-lite): when set, the
   * buffer flushes once its oldest part reaches this age even if every
   * incoming message keeps resetting the quiet-period timer (burst
   * starvation guard). Default undefined = disabled (previous behavior).
   */
  hardCapMs?: number;
  /** Minimum previous-message length that makes the next message a chunk. Default 4000. */
  chunkLengthThreshold?: number;
  /** Joiner used to concatenate buffered parts. Default "\n". */
  join?: string;
  /**
   * Timer scheduler, injectable for deterministic tests. Receives
   * (fn, ms) and must return a cancel function. Defaults to
   * setTimeout/clearTimeout.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Clock, injectable for deterministic tests. Default Date.now. */
  now?: () => number;
}

export type FlushFn = (chatId: number, text: string) => void;

interface ChatBuffer {
  parts: string[];
  cancelTimer: (() => void) | null;
  /** Timestamp (ms, from `now`) of the buffer's FIRST part; hard-cap anchor. */
  firstPushAt?: number;
}

export class TextBatchAggregator {
  private readonly buffers = new Map<number, ChatBuffer>();
  private readonly maxWaitMs: number;
  private readonly hardCapMs: number | undefined;
  private readonly join: string;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;

  constructor(
    private readonly flushFn: FlushFn,
    opts: TextBatchOptions = {},
  ) {
    this.maxWaitMs = opts.maxWaitMs ?? 800;
    this.hardCapMs = opts.hardCapMs;
    this.join = opts.join ?? "\n";
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
  }

  /** Buffer text for chatId, restarting its quiet-period timer. */
  push(chatId: number, text: string): void {
    let buf = this.buffers.get(chatId);
    if (!buf) {
      buf = { parts: [], cancelTimer: null };
      this.buffers.set(chatId, buf);
    }
    if (buf.parts.length === 0) buf.firstPushAt = this.now();
    buf.parts.push(text);
    this.resetTimer(chatId, buf);
  }

  /**
   * Buffer text for chatId and flush that chat's buffer immediately,
   * bypassing the quiet-period timer (ST-03).
   *
   * Use for single-part deliveries that gain nothing from batching — e.g. a
   * voice transcript is one complete message; waiting maxWaitMs only adds
   * latency. Batching exists to re-merge >4096-char text-message splits.
   * If the chat already had buffered parts (a text burst in flight), they are
   * coalesced into the same flush so ordering is preserved.
   */
  pushNow(chatId: number, text: string): void {
    this.push(chatId, text);
    this.flushChat(chatId);
  }

  /** Flush one chat immediately, or all chats when chatId is omitted. */
  flush(chatId?: number): void {
    if (chatId !== undefined) {
      this.flushChat(chatId);
      return;
    }
    for (const id of [...this.buffers.keys()]) {
      this.flushChat(id);
    }
  }

  /** Number of chats with buffered, not-yet-flushed text. */
  pendingCount(): number {
    return this.buffers.size;
  }

  /** Cancel every pending timer and drop all buffers. */
  destroy(): void {
    for (const buf of this.buffers.values()) {
      buf.cancelTimer?.();
    }
    this.buffers.clear();
  }

  private resetTimer(chatId: number, buf: ChatBuffer): void {
    buf.cancelTimer?.();
    buf.cancelTimer = this.schedule(() => {
      buf.cancelTimer = null;
      this.flushChat(chatId);
    }, this.maxWaitMs);
    // P-03-lite: hard cap on TOTAL buffer age, immune to quiet-period
    // resets. One timer per buffer, armed on the first part only; when it
    // fires, the buffer is flushed even if the burst never quiets down.
    if (this.hardCapMs !== undefined && buf.parts.length === 1) {
      const remainingCap = this.hardCapMs - (this.now() - buf.firstPushAt!);
      this.schedule(() => this.flush(chatId), Math.max(0, remainingCap));
    }
  }

  private flushChat(chatId: number): void {
    const buf = this.buffers.get(chatId);
    if (!buf) return;
    buf.cancelTimer?.();
    buf.cancelTimer = null;
    this.buffers.delete(chatId);
    this.flushFn(chatId, buf.parts.join(this.join));
  }
}

/**
 * Heuristic: is curText a continuation chunk of prevText (long-message
 * split)? A previous message at or above the threshold is treated as the
 * head of an over-long message, so whatever follows is aggregated with it.
 * Simple by design: the exact split boundary is decided by the caller.
 */
export function isLikelyTextChunk(prevText: string, curText: string, threshold = 4000): boolean {
  void curText;
  return prevText.length >= threshold;
}
