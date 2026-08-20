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
}

export type FlushFn = (chatId: number, text: string) => void;

interface ChatBuffer {
  parts: string[];
  cancelTimer: (() => void) | null;
}

export class TextBatchAggregator {
  private readonly buffers = new Map<number, ChatBuffer>();
  private readonly maxWaitMs: number;
  private readonly join: string;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly flushFn: FlushFn,
    opts: TextBatchOptions = {},
  ) {
    this.maxWaitMs = opts.maxWaitMs ?? 800;
    this.join = opts.join ?? "\n";
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
    buf.parts.push(text);
    this.resetTimer(chatId, buf);
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
