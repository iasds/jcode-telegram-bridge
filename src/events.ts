import type { Context } from "telegraf";
import { formatMessage, stripMdv2 } from "./markdown.js";
import { truncateMessage } from "./truncate.js";

/**
 * Rendering glue for the run() flow.
 *
 * Policy (user decision): no per-token streaming. We send one "working" line,
 * render tool-call status lines, then replace the working line with the final
 * answer. Long messages are chunked (hermes truncate_message port) so replies
 * never exceed Telegram's 4096-char limit. Falls back to plain text if
 * MarkdownV2 is rejected. 429 (flood) sends retry with backoff.
 */

export interface RendererOptions {
  disableLinkPreviews?: boolean;
}

const MAX_RETRIES = 3;

function retryAfterMs(err: unknown): number | undefined {
  const e = err as {
    response?: { parameters?: { retry_after?: number } };
  };
  const ra = e.response?.parameters?.retry_after;
  return typeof ra === "number" ? ra * 1000 : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TurnRenderer {
  private ctxCache = new Map<number, Context>();

  constructor(private opts: RendererOptions = {}) {}

  cacheContext(chatId: number, ctx: Context): void {
    this.ctxCache.set(chatId, ctx);
  }

  private linkPreview(): { is_disabled: true } | undefined {
    return this.opts.disableLinkPreviews ? { is_disabled: true } : undefined;
  }

  /** Send a "working" status message; returns its id so the final answer can replace it. */
  async sendWorking(chatId: number, replyTo?: number): Promise<number | undefined> {
    const ctx = this.ctxCache.get(chatId);
    if (!ctx) return undefined;
    try {
      const msg = await ctx.telegram.sendMessage(chatId, "⏳ Working…", {
        reply_parameters: replyTo ? { message_id: replyTo } : undefined,
        disable_notification: true,
      });
      return msg.message_id;
    } catch (err) {
      console.error("[renderer] working send failed:", err);
      return undefined;
    }
  }

  /** Send one tool-call status line. */
  async sendToolLine(chatId: number, name: string): Promise<void> {
    const ctx = this.ctxCache.get(chatId);
    if (!ctx) return;
    try {
      await ctx.telegram.sendMessage(chatId, `🔧 [${formatMessage(name)}]`, {
        disable_notification: true,
      });
    } catch (err) {
      console.error("[renderer] tool line failed:", err);
    }
  }

  private async sendRetry(
    ctx: Context,
    chatId: number,
    text: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.telegram.sendMessage(chatId, text, extra as never);
        return;
      } catch (err) {
        if (String(err).includes("429") && attempt < MAX_RETRIES - 1) {
          const wait = retryAfterMs(err) ?? 2000;
          console.warn(`[renderer] 429 flood, retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
  }

  /** Replace the working line with the final answer (markdown, chunked, with fallback). */
  async finishWith(chatId: number, workingMsgId: number | undefined, text: string): Promise<void> {
    const ctx = this.ctxCache.get(chatId);
    if (!ctx) return;
    const content = text.trim() || "*(no output)*";
    const chunks = truncateMessage(formatMessage(content));
    const preview = this.linkPreview();

    if (workingMsgId !== undefined) {
      try {
        // First chunk replaces the working line; the rest are sent fresh.
        await ctx.telegram.editMessageText(chatId, workingMsgId, undefined, chunks[0], {
          parse_mode: "MarkdownV2",
        });
        for (let i = 1; i < chunks.length; i++) {
          await this.sendRetry(ctx, chatId, chunks[i], { parse_mode: "MarkdownV2", link_preview_options: preview });
        }
        return;
      } catch (err) {
        if (String(err).includes("400")) {
          // MarkdownV2 rejected -> plain text, re-chunked
          const plain = truncateMessage(stripMdv2(content));
          try {
            await ctx.telegram.editMessageText(chatId, workingMsgId, undefined, plain[0]);
            for (let i = 1; i < plain.length; i++) {
              await this.sendRetry(ctx, chatId, plain[i], { link_preview_options: preview });
            }
            return;
          } catch {
            /* fall through to fresh send */
          }
        }
      }
    }
    await this.safeSendMessage(chatId, content);
  }

  /** Public: send a message with markdown fallback and chunking (used by bridge). */
  async safeSendMessage(chatId: number, text: string, replyTo?: number): Promise<void> {
    const ctx = this.ctxCache.get(chatId);
    if (!ctx) return;
    const chunks = truncateMessage(formatMessage(text));
    const preview = this.linkPreview();
    try {
      for (let i = 0; i < chunks.length; i++) {
        await this.sendRetry(ctx, chatId, chunks[i], {
          parse_mode: "MarkdownV2",
          reply_parameters: i === 0 && replyTo ? { message_id: replyTo } : undefined,
          link_preview_options: preview,
        });
      }
    } catch (err) {
      if (String(err).includes("400")) {
        const plain = truncateMessage(stripMdv2(text));
        try {
          for (let i = 0; i < plain.length; i++) {
            await this.sendRetry(ctx, chatId, plain[i], {
              reply_parameters: i === 0 && replyTo ? { message_id: replyTo } : undefined,
              link_preview_options: preview,
            });
          }
        } catch (err2) {
          console.error("[renderer] plain-text send failed:", err2);
        }
      } else {
        console.error("[renderer] send failed:", err);
      }
    }
  }
}
