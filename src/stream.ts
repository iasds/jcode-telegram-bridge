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
const MAX_EDIT_INTERVAL_MS = 10000;
const BUFFER_THRESHOLD = 24;
const CURSOR = " ▉";
const MAX_FLOOD_STRIKES = 3;

/** Tool name -> emoji for the onToolStart tool line (hermes-style). */
const TOOL_EMOJIS: Record<string, string> = {
  bash: "💻",
  shell: "💻",
  python: "🐍",
  node: "🟩",
  read: "📄",
  write: "📄",
  grep: "🔍",
  search: "🔍",
  web: "🌐",
  http: "🌐",
  git: "🔀",
};
const DEFAULT_TOOL_EMOJI = "⚙️";

/**
 * Map a tool name to an emoji: exact (case-insensitive) match first, then the
 * leftmost known key inside the name (so "web_search" -> 🌐 and
 * "http_request" -> 🌐), falling back to ⚙️ for anything unknown.
 */
function toolEmoji(name: string): string {
  const n = name.trim().toLowerCase();
  if (TOOL_EMOJIS[n]) return TOOL_EMOJIS[n];
  let bestIdx = Infinity;
  let bestKey = "";
  for (const key of Object.keys(TOOL_EMOJIS)) {
    const idx = n.indexOf(key);
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      bestKey = key;
    }
  }
  return bestKey ? TOOL_EMOJIS[bestKey] : DEFAULT_TOOL_EMOJI;
}

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
  private editIntervalMs = EDIT_INTERVAL_MS;
  // Codepoint count of `accumulated`, maintained incrementally per delta
  // (P-04). Spreading the whole accumulated buffer on every delta was
  // O(n²) over a long stream; counting only the NEW text is O(delta).
  // Invariant: valid while `accumulated` is only mutated via onDelta()
  // and reset to "" in onToolStart(); direct external assignment bypasses it.
  private cpCount = 0;

  constructor(
    private bot: Telegraf,
    private chatId: number,
    private replyTo?: number,
    private now: () => number = Date.now,
    private opts?: { disableLinkPreviews?: boolean },
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
          this.editIntervalMs = Math.min(this.editIntervalMs * 2, MAX_EDIT_INTERVAL_MS);
          if (this.floodStrikes >= MAX_FLOOD_STRIKES) {
            this.failed = true;
            return false;
          }
          const wait = retryAfterMs(err) ?? 2000;
          console.warn(`[stream] 429 flood, waiting ${wait}ms (edit interval ${this.editIntervalMs}ms)`);
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
    this.cpCount += [...text].length; // count only the new chunk, never re-spread the buffer
    const now = this.now();
    const elapsed = now - this.lastEditAt;
    if ((elapsed >= this.editIntervalMs && this.accumulated.length > 0) || this.cpCount >= BUFFER_THRESHOLD) {
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
    // Tool line: reuse 429 backoff (same as edit/sendChunk) so a flood on
    // tool lines doesn't silently drop the line.
    {
      const text = `${toolEmoji(name)} [${formatMessage(name)}]`;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.bot.telegram.sendMessage(this.chatId, text);
          break;
        } catch (err) {
          if (String(err).includes("429") && attempt < 2) {
            const wait = retryAfterMs(err) ?? 2000;
            console.warn(`[stream] 429 tool line, waiting ${wait}ms`);
            await sleep(wait);
            continue;
          }
          console.error("[stream] tool line failed:", err);
          break;
        }
      }
    }
    this.accumulated = "";
    this.cpCount = 0;
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
    const preview = this.opts?.disableLinkPreviews
      ? { link_preview_options: { is_disabled: true } }
      : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.bot.telegram.sendMessage(this.chatId, text, {
          parse_mode: "MarkdownV2",
          ...preview,
        });
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
            await this.bot.telegram.sendMessage(this.chatId, stripMdv2(text), preview);
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
