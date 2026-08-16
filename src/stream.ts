import type { Telegraf } from "telegraf";
import { formatMessage, stripMdv2 } from "./markdown.js";
import { truncateMessage } from "./truncate.js";

/**
 * Streaming reply renderer, ported 1:1 from hermes-agent's
 * GatewayStreamConsumer (gateway/stream_consumer.py) + Telegram adapter
 * streaming-edit path.
 *
 * - progressive editMessageText with plain text while streaming (unclosed
 *   markdown can't 400), cursor " ▉" appended
 * - edit throttle: at least 0.8s between edits, or flush once the buffer
 *   reaches 24 codepoints (hermes DEFAULT_STREAMING_EDIT_INTERVAL /
 *   DEFAULT_STREAMING_BUFFER_THRESHOLD)
 * - tool boundary: finalize current segment (MarkdownV2), send 🔧 line,
 *   continue on a fresh streamed message
 * - turn end: finalize with formatMessage (MarkdownV2, plain fallback),
 *   chunked over 4096 (hermes truncate_message)
 * - flood control: 429 -> Retry-After backoff; 3 strikes disables streaming
 *   (caller falls back to collecting the full text and delivering once)
 */

const EDIT_INTERVAL_MS = 800;
const BUFFER_THRESHOLD = 24;
const CURSOR = " ▉";
const MAX_FLOOD_STRIKES = 3;

function retryAfterMs(err: unknown): number | undefined {
  const e = err as { response?: { parameters?: { retry_after?: number } } };
  const ra = e.response?.parameters?.retry_after;
  return typeof ra === "number" ? ra * 1000 : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StreamingRenderer {
  accumulated = "";
  failed = false;
  msgId: number | undefined;
  private lastEditAt = 0;
  private floodStrikes = 0;
  private cancelled = false;

  constructor(
    private bot: Telegraf,
    private chatId: number,
    private replyTo?: number,
    private now: () => number = Date.now,
  ) {}

  /** Send the initial streamed message (just the cursor); returns its id. */
  async start(): Promise<number | undefined> {
    try {
      const msg = await this.bot.telegram.sendMessage(this.chatId, CURSOR, {
        reply_parameters: this.replyTo ? { message_id: this.replyTo } : undefined,
      });
      this.msgId = msg.message_id;
      return msg.message_id;
    } catch (err) {
      console.error("[stream] start failed:", err);
      return undefined;
    }
  }

  private async edit(content: string, markdown = false): Promise<boolean> {
    if (this.cancelled || this.msgId === undefined) return false;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.bot.telegram.editMessageText(this.chatId, this.msgId, undefined, content, {
          parse_mode: markdown ? "MarkdownV2" : undefined,
        });
        return true;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("429") && attempt < 2) {
          this.floodStrikes++;
          if (this.floodStrikes >= MAX_FLOOD_STRIKES) {
            this.failed = true;
            return false;
          }
          const wait = retryAfterMs(err) ?? 2000;
          console.warn(`[stream] 429 flood, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
        if (msg.includes("not modified")) return true; // no-op, keeps flood budget
        if (markdown) {
          try {
            await this.bot.telegram.editMessageText(this.chatId, this.msgId, undefined, stripMdv2(content));
            return true;
          } catch {
            /* fall through */
          }
        }
        console.error("[stream] edit failed:", err);
        return false;
      }
    }
  }

  /** Stream one delta; throttled edit per hermes rules. */
  async onDelta(text: string): Promise<void> {
    if (this.failed) return;
    this.accumulated += text;
    const now = this.now();
    const elapsed = now - this.lastEditAt;
    const cpLen = [...this.accumulated].length;
    if ((elapsed >= EDIT_INTERVAL_MS && this.accumulated.length > 0) || cpLen >= BUFFER_THRESHOLD) {
      this.lastEditAt = now;
      await this.edit(this.accumulated + CURSOR);
    }
  }

  /** Tool boundary: finalize the current segment, emit the tool line, start fresh. */
  async onToolStart(name: string): Promise<void> {
    if (this.failed) return;
    if (this.accumulated.trim()) {
      await this.edit(formatMessage(this.accumulated), true);
    }
    try {
      await this.bot.telegram.sendMessage(this.chatId, `🔧 [${formatMessage(name)}]`);
    } catch (err) {
      console.error("[stream] tool line failed:", err);
    }
    this.accumulated = "";
    this.lastEditAt = 0;
    const msg = await this.bot.telegram.sendMessage(this.chatId, CURSOR);
    if (msg) this.msgId = msg.message_id;
  }

  /** Turn end: finalize with MarkdownV2, chunked over 4096, no cursor. */
  async finish(): Promise<void> {
    if (this.cancelled || this.msgId === undefined) return;
    const text = this.accumulated.trim() || "*(no output)*";
    const chunks = truncateMessage(formatMessage(text));
    await this.edit(chunks[0], true);
    for (let i = 1; i < chunks.length; i++) {
      await this.sendChunk(chunks[i]);
    }
  }

  /**
   * Send one reply chunk (chunks 2+) with 429 Retry-After backoff and a
   * plain-text fallback when MarkdownV2 is rejected, matching the run()
   * renderer's sendRetry policy so long replies never silently drop words.
   */
  private async sendChunk(text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "MarkdownV2" });
        return;
      } catch (err) {
        if (String(err).includes("429") && attempt < 2) {
          const wait = retryAfterMs(err) ?? 2000;
          console.warn(`[stream] 429 flood, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
        if (String(err).includes("400")) {
          // MarkdownV2 rejected -> plain text
          try {
            await this.bot.telegram.sendMessage(this.chatId, stripMdv2(text));
            return;
          } catch (err2) {
            console.error("[stream] plain chunk send failed:", err2);
            return;
          }
        }
        console.error("[stream] chunk send failed:", err);
        return;
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
  }
}
