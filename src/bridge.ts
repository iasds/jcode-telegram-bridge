import { JcodeClient, HarnessError } from "@1jehuang/jcode-sdk";
import { Telegraf } from "telegraf";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig } from "./config.js";
import { enrichTextWithTranscript, transcribeAudio } from "./stt.js";
import { SessionStore, QueueFullError } from "./sessions.js";
import { TextBatchAggregator } from "./batch.js";
import { TurnRenderer } from "./events.js";
import { handleCommand, BridgeHooks } from "./commands.js";
import { sendModelPicker, handleModelPickerCallback } from "./model-picker.js";
import { StreamingRenderer } from "./stream.js";
import {
  advanceOffset,
  parseOffset,
  isFatalHarnessError,
  canFallbackToRun,
} from "./logic.js";

const cfg = loadConfig();

async function connectWithRetry(): Promise<JcodeClient> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await JcodeClient.connect({
        clientName: "jcode-telegram-bridge/1.0",
        requestTimeoutMs: cfg.turnTimeoutMs + 30_000,
      });
    } catch (err) {
      lastErr = err;
      console.error(
        `[bridge] connect attempt ${attempt}/6 failed: ${err instanceof Error ? err.message : String(err)}; retrying in 5s`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

const client = await connectWithRetry();
const store = new SessionStore(client, cfg);
const renderer = new TurnRenderer({ disableLinkPreviews: cfg.disableLinkPreviews });

const openModelPicker = async (chatId: number, replyTo?: number): Promise<void> => {
  const st = await store.getOrCreate(chatId);
  await client.attachSession(st.sessionId);
  await sendModelPicker(bot, client, st.sessionId, chatId, replyTo);
};

// Self-heal: if the harness connection dies (api-bridge restarted, daemon
// restarted, socket closed), exit so systemd Restart=always brings us back
// with a fresh connection. Without this the bridge idles forever on a dead
// socket and every turn fails silently.
function fatalExit(reason: string): never {
  console.error(`[bridge] fatal connection error (${reason}); exiting for systemd restart`);
  process.exit(1);
}
client.on("error", (err: unknown) => {
  fatalExit(`transport error: ${err instanceof Error ? err.message : String(err)}`);
});
// The harness closes the socket cleanly when api-bridge exits (systemctl stop,
// crash, daemon restart). That surfaces as a "close" event, not an "error";
// without this listener the bridge idles on a dead client and every turn
// fails with "harness connection closed" forever.
//
// A close right after an attach usually means the daemon reset the socket
// because the attached session is poisoned (a turn stuck server-side). If we
// just restart, the new process re-attaches the same broken session and the
// restart loop never ends (and before offset persistence that loop also
// re-sent the same reply). So on close we drop the mapping for the last
// attached session and persist synchronously before exiting; systemd brings
// us back with a fresh connection and a fresh session.
let lastAttachSession: string | undefined;
client.on("close", () => {
  if (lastAttachSession) {
    for (const [chatId, st] of store.all()) {
      if (st.sessionId === lastAttachSession) {
        console.warn(
          `[bridge] rotating session ${lastAttachSession.slice(0, 16)}… after connection close`,
        );
        store.remove(chatId);
      }
    }
    store.persistNow();
    lastAttachSession = undefined;
  }
  fatalExit("harness connection closed");
});

// In-flight turns per chat: /cancel aborts the controller and closes the
// child connection so the events() loop unwinds promptly instead of waiting
// for turn_done or the ~10.5min request timeout.
const activeTurns = new Map<number, { ac: AbortController; child: JcodeClient }>();
function cancelTurn(chatId: number): void {
  const t = activeTurns.get(chatId);
  if (!t) return;
  t.ac.abort();
  void t.child.close().catch(() => undefined);
}

// Last non-command text per chat (for /retry).
const lastUserTexts = new Map<number, string>();
// Cached ctx per chat (for batched flush + /retry re-route).
const lastCtx = new Map<number, any>();
// Quiet-period text aggregation for >4096 message splits (C14).
const textBatcher = new TextBatchAggregator(
  (chatId, text) => {
    const ctx = lastCtx.get(chatId);
    if (ctx) void route(ctx, text);
  },
  { maxWaitMs: 500 },
);
// Persisted home channel (alongside state.json).
const HOME_FILE = join(dirname(cfg.stateFile), "home.json");
let homeChatId: number | undefined;
function loadHome(): number | undefined {
  try {
    const n = Number(JSON.parse(readFileSync(HOME_FILE, "utf8")).chatId);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}
function saveHome(chatId: number): void {
  try {
    writeFileSync(HOME_FILE, JSON.stringify({ chatId }), { mode: 0o600 });
  } catch (err) {
    console.error("[bridge] save home failed:", err);
  }
}
homeChatId = loadHome();

const hooks: BridgeHooks = {
  openModelPicker,
  cancelTurn,
  activeTurns: () => activeTurns.size,
  lastUserText: (chatId) => lastUserTexts.get(chatId),
  retryLast: (chatId) => {
    const last = lastUserTexts.get(chatId);
    if (last) void route({ chat: { id: chatId }, message: { message_id: undefined } } as never, last);
  },
  homeChat: {
    set: (chatId) => {
      homeChatId = chatId;
      saveHome(chatId);
    },
    get: () => homeChatId,
  },
};

// Custom agent: socket idle timeout 60s so a stuck long-poll (proxy hangs the
// connection without responding) errors out instead of hanging forever.
// telegraf's own request timeout is hardcoded to 500s, which would leave the
// bridge deaf to Telegram for minutes. On socket timeout the getUpdates call
// rejects, polling stops, launch() rejects, and fatalExit restarts via systemd.
const bot = new Telegraf(cfg.botToken, {
  telegram: {
    agent: new https.Agent({ keepAlive: true, timeout: 60_000, keepAliveMsecs: 10_000 }),
  },
});

let botUsername: string | undefined;

function allowed(fromId: number | undefined): boolean {
  if (!fromId) return false;
  if (cfg.allowedIds.length === 0) return true;
  return cfg.allowedIds.includes(fromId);
}

/** Strip a leading @botname mention for group messages. */
function stripMention(text: string, botUsername?: string): string {
  if (!botUsername) return text;
  const re = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,:-]*`, "i");
  return text.replace(re, "").trim();
}

bot.use(async (_ctx, next) => next());

bot.start(async (ctx) => {
  if (!allowed(ctx.from?.id)) return;
  renderer.cacheContext(ctx.chat.id, ctx);
  await handleCommand(ctx, "/start", client, store, renderer, cfg, hooks);
});

bot.help(async (ctx) => {
  if (!allowed(ctx.from?.id)) return;
  renderer.cacheContext(ctx.chat.id, ctx);
  await handleCommand(ctx, "/help", client, store, renderer, cfg, hooks);
});

bot.on("callback_query", (ctx) => {
  void handleModelPickerCallback(bot, client, ctx).catch((err) => {
    console.error("[bridge] callback error:", err);
  });
});

bot.on("text", async (ctx) => {
  const chat = ctx.chat;
  const fromId = ctx.from?.id;
  if (!chat || !fromId) return;
  renderer.cacheContext(chat.id, ctx);
  lastCtx.set(chat.id, ctx);
  if (!allowed(fromId)) {
    console.log(`[bridge] ignored message from non-allowed user ${fromId}`);
    return;
  }
  if (cfg.chatOnly && chat.type !== "private") {
    console.log(`[bridge] ignored ${chat.type} message (chat-only mode) from ${fromId}`);
    return;
  }
  // Long-message chunk aggregation (C14): commands go straight to route(),
  // plain text is quiet-period batched so >4096 splits arrive as one turn.
  const deliver = (text: string) => {
    if (text.trim().startsWith("/")) {
      void route(ctx, text);
    } else {
      textBatcher.push(chat.id, text);
    }
  };
  if (chat.type === "private") {
    deliver(ctx.message.text);
  } else if (chat.type === "group" || chat.type === "supergroup") {
    // Group chats: only respond when the bot is mentioned. Cache the
    // bot username so we don't hit getMe on every group message.
    if (botUsername === undefined) {
      botUsername = (await bot.telegram.getMe().catch(() => undefined))?.username;
    }
    const text = stripMention(ctx.message.text, botUsername);
    if (text && text !== ctx.message.text) {
      deliver(text);
    }
  }
});

// ---- Media input (C2): text documents (<=100KB) are inlined into the turn;
// ---- other media become descriptive placeholders (model has no vision).
const TEXT_EXT = /\.(txt|md|markdown|json|log|csv|py|js|ts|tsx|jsx|go|rs|java|c|cpp|h|hpp|sh|bash|zsh|yaml|yml|toml|ini|xml|html|css|sql|env|conf|cfg)$/i;
const MAX_INLINE_DOC_BYTES = 100_000;

function mediaDeliver(chatId: number, ctx: any, text: string): void {
  if (cfg.chatOnly && ctx.chat?.type !== "private") return;
  lastCtx.set(chatId, ctx);
  renderer.cacheContext(chatId, ctx);
  textBatcher.push(chatId, text);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function handleDocument(ctx: any): Promise<void> {
  const chatId = ctx.chat.id;
  const fromId = ctx.from?.id;
  if (!chatId || !allowed(fromId)) return;
  const doc = ctx.message.document;
  const name = doc.file_name ?? "document";
  const size = doc.file_size ?? 0;
  const caption = ctx.message.caption ?? "";
  const isText =
    TEXT_EXT.test(name) || (typeof doc.mime_type === "string" && doc.mime_type.startsWith("text/"));
  if (!isText || size > MAX_INLINE_DOC_BYTES) {
    mediaDeliver(
      chatId,
      ctx,
      `📎 The user sent a file: ${name} (${fmtBytes(size)}).${caption ? ` Caption: ${caption}` : ""}`,
    );
    return;
  }
  try {
    const f = await ctx.telegram.getFile(doc.file_id);
    if (!f.file_path) throw new Error("no file_path");
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${f.file_path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    mediaDeliver(
      chatId,
      ctx,
      `[Content of ${name}]:\n${content}${caption ? `\n\nCaption: ${caption}` : ""}`,
    );
  } catch (err) {
    console.error("[bridge] document fetch failed:", err);
    mediaDeliver(chatId, ctx, `📎 [${name}] — failed to read content: ${String(err)}`);
  }
}

bot.on("document", (ctx) => {
  void handleDocument(ctx).catch((err) => console.error("[bridge] document handler error:", err));
});
bot.on("photo", (ctx) => {
  const chatId = ctx.chat.id;
  if (!allowed(ctx.from?.id)) return;
  mediaDeliver(
    chatId,
    ctx,
    `📷 [photo]${ctx.message.caption ? ` Caption: ${ctx.message.caption}` : ""}`,
  );
});
bot.on("voice", (ctx) => {
  void handleVoice(ctx, "voice").catch((err) => console.error("[bridge] voice handler error:", err));
});
bot.on("video_note", (ctx: any) => {
  void handleVoice(ctx, "video_note").catch((err) => console.error("[bridge] video_note handler error:", err));
});
bot.on("video", (ctx) => {
  const chatId = ctx.chat.id;
  if (!allowed(ctx.from?.id)) return;
  mediaDeliver(
    chatId,
    ctx,
    `🎬 [video]${ctx.message.caption ? ` Caption: ${ctx.message.caption}` : ""}`,
  );
});
bot.on("audio", (ctx) => {
  // audio doc may be voice-like or music — treat as potential STT if small, else placeholder
  const f = (ctx.message as any).audio;
  const size = f?.file_size ?? 0;
  if (size > 25 * 1024 * 1024 || !cfg.stt.enabled) {
    const chatId = ctx.chat.id;
    if (!allowed(ctx.from?.id)) return;
    mediaDeliver(chatId, ctx, "🎵 [audio]");
    return;
  }
  void handleVoice(ctx, "audio").catch((err) => console.error("[bridge] audio handler error:", err));
});

async function downloadTelegramFile(fileId: string): Promise<{ path: string; ext: string; durablePath: string } | null> {
  const file: any = await bot.telegram.getFile(fileId);
  if (!file?.file_path) return null;
  const ext = file.file_path.includes(".") ? "." + file.file_path.split(".").pop()!.split("?")[0] : ".ogg";
  const { tmpdir: getTmpdir } = await import("node:os");
  const { join, basename: baseName } = await import("node:path");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const tmpPath = join(getTmpdir(), `jcode-voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const url = `https://api.telegram.org/file/bot${cfg.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading voice`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tmpPath, buf);
  // durable copy for the agent (tmp is deleted after STT; hermes keeps download dir)
  const durableDir = join(cfg.workDir, ".jcode-media", "telegram-voice");
  try { mkdirSync(durableDir, { recursive: true }); } catch {}
  const rawBase = (file.file_path.split("/").pop() ?? `voice-${Date.now()}${ext}`).split("?")[0];
  const durableName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${baseName(rawBase)}`;
  const finalDurable = durableName.includes(".") ? durableName : `${durableName}${ext}`;
  const durablePath = join(durableDir, finalDurable);
  try { writeFileSync(durablePath, buf); } catch (e) { console.error("[bridge] durable write failed:", e); }
  return { path: tmpPath, ext, durablePath };
}

async function handleVoice(ctx: any, kind: "voice" | "audio" | "video_note"): Promise<void> {
  const chatId = ctx.chat?.id;
  const fromId = ctx.from?.id;
  if (!chatId || !allowed(fromId)) return;
  if (cfg.chatOnly && ctx.chat?.type !== "private") return;
  renderer.cacheContext(chatId, ctx);
  lastCtx.set(chatId, ctx);

  const caption: string = ctx.message?.caption ?? "";
  // Extract file_id by kind
  let fileId: string | undefined;
  let fileSize = 0;
  if (kind === "voice") { fileId = ctx.message?.voice?.file_id; fileSize = ctx.message?.voice?.file_size ?? 0; }
  else if (kind === "video_note") { fileId = ctx.message?.video_note?.file_id; fileSize = ctx.message?.video_note?.file_size ?? 0; }
  else if (kind === "audio") { fileId = ctx.message?.audio?.file_id; fileSize = ctx.message?.audio?.file_size ?? 0; }

  if (!fileId) {
    mediaDeliver(chatId, ctx, kind === "voice" ? "🎤 [voice message]" : `🎵 [${kind}]`);
    return;
  }
  if (fileSize > 25 * 1024 * 1024) {
    mediaDeliver(chatId, ctx, `🎤 [voice message too large: ${fmtBytes(fileSize)} — not transcribed]${caption ? ` Caption: ${caption}` : ""}`);
    return;
  }
  if (!cfg.stt.enabled) {
    mediaDeliver(chatId, ctx, `🎤 [voice message]${caption ? ` Caption: ${caption}` : ""}`);
    return;
  }

  // Notify user we're transcribing (typing action)
  void bot.telegram.sendChatAction(chatId, "typing").catch(() => undefined);

  let tmpPath: string | null = null;
  let durableVoicePath: string | null = null;
  try {
    const dl = await downloadTelegramFile(fileId);
    if (!dl) throw new Error("getFile returned no file_path");
    tmpPath = dl.path;
    durableVoicePath = (dl as any).durablePath as string | null;
    // transcribe with bridge stt config (zh/small by default)
    const sttCfg = { enabled: cfg.stt.enabled, echoTranscripts: cfg.stt.echoTranscripts, provider: cfg.stt.provider, language: cfg.stt.language, localModel: cfg.stt.localModel } as any;
    const res = await transcribeAudio(tmpPath, sttCfg);
    if (res.success && res.transcript.trim()) {
      const enriched = enrichTextWithTranscript(caption, [res.transcript]);
      if (cfg.stt.echoTranscripts) {
        // Echo like hermes gateway/run.py _echo_pending_stt_transcripts_once: 🎙️ "transcript"
        void renderer.safeSendMessage(chatId, `🎙️ "${res.transcript.trim()}"`, ctx.message?.message_id).catch(() => undefined);
      }
      console.log(`[stt] ${kind} -> ${res.provider} ${res.transcript.slice(0, 80)}…`);
      const withFile = durableVoicePath ? `${enriched}\n\n[attached audio file: ${durableVoicePath}]` : enriched;
      mediaDeliver(chatId, ctx, withFile);
    } else {
      const errNote = res.error ?? "unknown error";
      console.warn(`[stt] ${kind} failed [${res.provider}]: ${errNote}`);
      const unavailableAnchor = durableVoicePath ?? tmpPath ?? undefined;
      let enriched = enrichTextWithTranscript(caption, [], unavailableAnchor);
      if (durableVoicePath) enriched += `\n\n[attached audio file: ${durableVoicePath}]`;
      // enriched here is the unavailable note + caption
      mediaDeliver(chatId, ctx, enriched);
      if (caption) {
        // also log for operator
      }
    }
  } catch (err: any) {
    console.error(`[stt] ${kind} error:`, err?.message ?? err);
    mediaDeliver(chatId, ctx, `🎤 [voice message — transcription failed: ${String(err?.message ?? err).slice(0, 200)}]${caption ? ` Caption: ${caption}` : ""}`);
  } finally {
    if (tmpPath) { try { const { unlinkSync } = await import("node:fs"); unlinkSync(tmpPath); } catch {} }
  }
}
bot.on("sticker", (ctx) => {
  const chatId = ctx.chat.id;
  if (!allowed(ctx.from?.id)) return;
  mediaDeliver(chatId, ctx, "😀 [sticker]");
});
bot.on("location", (ctx) => {
  const chatId = ctx.chat.id;
  if (!allowed(ctx.from?.id)) return;
  mediaDeliver(chatId, ctx, "📍 [location]");
});

async function route(ctx: any, text: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const trimmed = text.trim();

  // Commands first.
  if (trimmed.startsWith("/")) {
    const handled = await handleCommand(ctx, trimmed, client, store, renderer, cfg, hooks);
    if (handled) return;
    // Unknown command: do NOT fall through to a normal turn (that would send
    // e.g. /new to the agent as plain text). Reply and stop.
    await renderer.safeSendMessage(
      chatId,
      `Unknown command: ${trimmed.split(/\s+/)[0]}\nSend /help for available commands.`,
      ctx.message?.message_id,
    );
    return;
  }

  // Normal turn: getOrCreate + attach happen INSIDE the queue so two rapid
  // messages can never attach the same session concurrently (a rotation on
  // one could race the other's attach and double-create). Turns are
  // fire-and-forget so telegraf keeps processing updates (e.g. /cancel).
  lastUserTexts.set(chatId, trimmed);
  const userMsgId = ctx.message?.message_id;
  void store.enqueue(
    chatId,
      async () => {
        // -- session lookup + attach (serialized per chat) -----------------
        let st = await store.getOrCreate(chatId);
        try {
          await client.attachSession(st.sessionId);
        lastAttachSession = st.sessionId;
      } catch (err) {
        // Session is missing on the daemon (cleared/pruned/daemon restart) or
        // poisoned (attach makes the daemon reset the socket). Drop the stale
        // mapping and recreate so the chat recovers automatically. A truly
        // dead connection raises FATAL_CODES and propagates to the queue
        // catch below (process-level exit).
        if (isFatalHarnessError(err)) throw err;
        console.warn(
          `[route] attach ${st.sessionId.slice(0, 16)}… failed (${err instanceof Error ? err.message : String(err)}); recreating`,
        );
        const mode = st.mode; // preserve plan mode across rotation
        store.remove(chatId);
        st = await store.getOrCreate(chatId);
        if (st.mode !== mode) {
          st = { ...st, mode };
          store.set(chatId, st);
        }
        await client.attachSession(st.sessionId);
        lastAttachSession = st.sessionId;
      }
      const content =
        st.mode === "plan" ? `${cfg.planModePrefix}\n${trimmed}` : trimmed;
      const replyTo = ctx.message?.message_id;

      // -- streaming path ------------------------------------------------
      // A per-turn child connection (same pattern the SDK's globalEvents uses
      // internally) consumes events() reliably, letting the reply stream into
      // Telegram via progressive edits. Falls back to run() only if the turn
      // never started; a half-sent message is never re-run (double-execution).
      console.log("[stream] connect");
      const child = await JcodeClient.connect({
        clientName: "jcode-tg-bridge-stream/1.0",
        requestTimeoutMs: cfg.turnTimeoutMs + 30_000,
      });
      console.log("[stream] connected");
      const ac = new AbortController();
      activeTurns.set(chatId, { ac, child });
      // Visual feedback: typing indicator every 4s + optional 👀 reaction.
      const typingTimer = setInterval(() => {
        void bot.telegram.sendChatAction(chatId, "typing").catch(() => undefined);
      }, 4000);
      let turnFailed = false;
      if (cfg.enableReactions && userMsgId !== undefined) {
        void bot.telegram
          .setMessageReaction(chatId, userMsgId, [{ type: "emoji", emoji: "👀" }])
          .catch(() => undefined);
      }
      let stream: StreamingRenderer | null = null;
      let working: number | undefined;
      let turnStarted = false;
      let accumulated = "";
      let timedOut = false;
      // Watchdog: if the daemon never emits turn_done/error, tell the user and
      // tear down the child instead of hanging silently until the request
      // timeout.
      const watchdog = setTimeout(() => {
        timedOut = true;
        if (stream && !stream.failed) void stream.finish().catch(() => undefined);
        void renderer
          .safeSendMessage(chatId, "⏱ Turn timed out, interrupted. Try again or /clear.", replyTo)
          .catch(() => undefined);
        void child.close().catch(() => undefined);
      }, cfg.turnTimeoutMs);
      try {
        console.log("[stream] attach", st.sessionId.slice(0, 20));
        await child.attachSession(st.sessionId);
        lastAttachSession = st.sessionId;
        console.log("[stream] attached");
        stream = new StreamingRenderer(bot, chatId, replyTo, undefined, {
          disableLinkPreviews: cfg.disableLinkPreviews,
        });
        working = await stream.start();
        if (working === undefined) stream = null; // initial send failed -> fallback
        try {
          await child.sendMessage(st.sessionId, content, { waitForAccept: false });
        } catch (sendErr) {
          // The frame may already have reached the daemon (half-failure).
          // Never run() again on this content — that would execute the turn
          // twice and double-reply.
          console.error("[route] sendMessage failed (turn may have started):", sendErr);
        }
        turnStarted = true;
        console.log("[stream] consuming events");
        let evCount = 0;
        for await (const ev of child.events(st.sessionId)) {
          if (ac.signal.aborted) break;
          evCount++;
          if (ev.ev === "turn_done") { console.log("[stream] turn_done, events:", evCount); break; }
          if (ev.ev === "text_delta") {
            accumulated += ev.text;
            if (stream && !stream.failed) await stream.onDelta(ev.text);
          } else if (ev.ev === "tool_start") {
            const name = (ev as { name?: string }).name ?? "tool";
            if (stream && !stream.failed) await stream.onToolStart(name);
          }
        }
        console.log("[stream] loop end, events:", evCount, "failed:", stream?.failed);
        if (ac.signal.aborted) {
          // /cancel with a clean events() close: finalize the partial text
          // (drop the ▉ cursor) and report once.
          if (stream && !stream.failed) await stream.finish().catch(() => undefined);
          await renderer
            .safeSendMessage(chatId, "⏹ Cancelled.", replyTo)
            .catch(() => undefined);
          return;
        }
        if (stream && !stream.failed) {
          await stream.finish();
          console.log("[stream] finished");
        } else {
          // streaming disabled/never started: deliver collected text once
          if (stream) stream.cancel();
          await renderer.finishWith(chatId, working, accumulated);
        }
      } catch (err) {
        turnFailed = true;
        if (ac.signal.aborted) {
          // /cancel: the child was closed on purpose; finalize partial text
          // and report, don't surface an error.
          if (stream && !stream.failed) await stream.finish().catch(() => undefined);
          await renderer
            .safeSendMessage(chatId, "⏹ Cancelled.", replyTo)
            .catch(() => undefined);
          return;
        }
        if (timedOut) return; // watchdog already reported the timeout
        if (isFatalHarnessError(err)) throw err;
        console.error("[route] stream error:", err);
        if (stream) await stream.cancel();
        if (canFallbackToRun(turnStarted)) {
          // Safe to run() once: the turn never began on the daemon.
          try {
            const result = await client.run(st.sessionId, content, { autoApprove: true });
            const w = working ?? (await renderer.sendWorking(chatId, replyTo));
            await renderer.finishWith(chatId, w, result.text ?? "");
          } catch (err2) {
            if (isFatalHarnessError(err2)) throw err2;
            const msg = err2 instanceof HarnessError
              ? `jcode error [${err2.code}]: ${err2.message}`
              : String(err2);
            await renderer.safeSendMessage(chatId, `⚠️ ${msg}`, replyTo);
          }
        } else {
          const msg = err instanceof HarnessError ? `jcode error [${err.code}]: ${err.message}` : String(err);
          await renderer.finishWith(chatId, working, accumulated || `⚠️ ${msg}`);
        }
    } finally {
      clearTimeout(watchdog);
      clearInterval(typingTimer);
      if (cfg.enableReactions && userMsgId !== undefined) {
        void bot.telegram
          .setMessageReaction(chatId, userMsgId, [{ type: "emoji", emoji: turnFailed ? "👎" : "👍" }])
          .catch(() => undefined);
      }
      activeTurns.delete(chatId);
      await child.close().catch(() => undefined);
    }
  }, cfg.queueLimit).catch((err) => {
    if (err instanceof QueueFullError) {
      console.warn(`[route] queue full for chat ${chatId} (limit ${err.limit})`);
      void renderer
        .safeSendMessage(
          chatId,
          `⏳ Queue is full (${err.limit} turns max). Wait for the current turn, then retry.`,
          ctx.message?.message_id,
        )
        .catch(() => undefined);
      return;
    }
    console.error("[route] queue error:", err);
    if (isFatalHarnessError(err)) {
      fatalExit(`queue turn failed [${(err as { code?: string }).code ?? ""}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    const msg = err instanceof HarnessError
      ? `jcode error [${err.code}]: ${err.message}`
      : String(err);
    void renderer
      .safeSendMessage(chatId, `⚠️ ${msg}`, ctx.message?.message_id)
      .catch(() => undefined);
  });
}

console.log(`[bridge] started. bot=${cfg.botToken.split(":")[0]} allowed=${cfg.allowedIds.length ? cfg.allowedIds.join(",") : "(all)"} workdir=${cfg.workDir}`);

bot.catch((err, ctx) => {
  console.error("[bridge] bot error:", err, "ctx:", ctx?.update?.update_id);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

/**
 * Custom long-poll loop.
 *
 * telegraf's built-in polling has a hardcoded 500s request timeout; behind a
 * transparent proxy a hung getUpdates can occupy the only keep-alive socket
 * forever, blocking every sendMessage (HTTP/1.1 serializes per connection).
 * We poll ourselves with an AbortSignal hard timeout so a stuck request is
 * aborted and retried after a short backoff, keeping the bridge responsive.
 */
async function getUpdatesRaw(
  token: string,
  offset: number,
  signal: AbortSignal,
): Promise<{ update_id: number }[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=15&allowed_updates=`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { ok: boolean; result?: { update_id: number }[]; description?: string };
  if (!data.ok) throw new Error(data.description ?? "getUpdates failed");
  return data.result ?? [];
}

/**
 * Custom long-poll loop using native fetch.
 *
 * telegraf's callApi hardcodes a 500s request timeout and its abort signal
 * only covers the request phase: a proxy that sends response headers but
 * stalls the body leaves res.json() hanging forever with no active requests.
 * Native fetch + AbortSignal.timeout covers the whole body read, and the
 * short 15s Telegram-side poll keeps every request short-lived.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Persisted poll offset: on restart we must NOT re-pull already-delivered
// updates (getUpdates(offset=0) returns every unconfirmed update again, so a
// crash/restart loop would re-handle the same message and re-send the same
// reply — the "bot loops sending the same message" bug). Path derives from
// stateFile so STATE_FILE relocation moves the offset too.
function loadOffset(): number {
  try {
    return parseOffset(readFileSync(cfg.offsetFile, "utf8"));
  } catch {
    return 0;
  }
}
function saveOffset(offset: number): void {
  try {
    writeFileSync(cfg.offsetFile, String(offset), { mode: 0o600 });
  } catch (err) {
    console.error("[bridge] save offset failed:", err);
  }
}

async function pollLoop(bot: Telegraf): Promise<void> {
  // getMe with backoff: a transient network blip (proxy drop) must not kill
  // the process — that is what started the restart loop.
  let bootErrors = 0;
  for (;;) {
    try {
      await bot.telegram.getMe();
      break;
    } catch (err) {
      bootErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge] getMe failed (${bootErrors}/10): ${msg}`);
      if (bootErrors >= 10) {
        fatalExit(`getMe failed ${bootErrors}x: ${msg}`);
      }
      await sleep(Math.min(3000 * bootErrors, 15000));
    }
  }
  console.log("[bridge] telegram polling started (native fetch loop)");
  // Command menu + online indicator (hermes set_my_commands / status_indicator parity).
  const COMMAND_MENU = [
    { command: "start", description: "Welcome and status" },
    { command: "help", description: "This help" },
    { command: "status", description: "Bridge and daemon status" },
    { command: "info", description: "Session runtime info" },
    { command: "clear", description: "Clear session history" },
    { command: "plan", description: "Toggle plan mode" },
    { command: "model", description: "View or switch model" },
    { command: "compact", description: "Compress context" },
    { command: "cancel", description: "Cancel current turn" },
    { command: "undo", description: "Undo last turn" },
    { command: "title", description: "Set session title" },
    { command: "sessions", description: "List sessions" },
    { command: "retry", description: "Retry last message" },
    { command: "sethome", description: "Set home channel" },
    { command: "restart", description: "Restart bridge" },
    { command: "update", description: "Update bridge" },
  ];
  void bot.telegram
    .setMyCommands(COMMAND_MENU)
    .catch((e) => console.error("[bridge] setMyCommands failed:", e));
  void bot.telegram
    .setMyShortDescription("Jcode bridge: online")
    .catch(() => undefined);
  let offset = loadOffset();
  let consecutiveErrors = 0;
  while (true) {
    let updates: { update_id: number }[];
    try {
      updates = await getUpdatesRaw(cfg.botToken, offset, AbortSignal.timeout(45_000));
      consecutiveErrors = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveErrors++;
      console.error(`[bridge] getUpdates error (${consecutiveErrors}): ${msg}`);
      if (consecutiveErrors >= 5) {
        fatalExit(`getUpdates failed ${consecutiveErrors}x: ${msg}`);
      }
      await sleep(Math.min(3000 * consecutiveErrors, 15000));
      continue;
    }
    if (updates.length > 0) {
      offset = advanceOffset(updates, offset);
      saveOffset(offset);
      await Promise.all(
        updates.map((u) => bot.handleUpdate(u as never).catch((e: unknown) => {
          console.error("[bridge] handleUpdate error:", e);
        })),
      );
    }
  }
}

void pollLoop(bot).catch((err) => {
  console.error("[bridge] poll loop fatal:", err);
  process.exit(1);
});
