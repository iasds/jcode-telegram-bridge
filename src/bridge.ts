import { JcodeClient, HarnessError } from "@1jehuang/jcode-sdk";
import { Telegraf } from "telegraf";
import type { Telegram } from "telegraf";
import https from "node:https";
import { chmodSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { writeFileAtomic } from "./fsutil.js";
import { enrichTextWithTranscript, transcribeAudio, warmupResident } from "./stt.js";
import { SessionStore, QueueFullError } from "./sessions.js";
import { TextBatchAggregator } from "./batch.js";
import { TurnRenderer } from "./events.js";
import { handleCommand, BridgeHooks } from "./commands.js";
import { sendModelPicker, handleModelPickerCallback } from "./model-picker.js";
import { StreamingRenderer } from "./stream.js";
import { PollErrorLogger, FATAL_THRESHOLD as FATAL_ATTEMPTS } from "./pollwatch.js";
import {
  advanceOffset,
  parseOffset,
  isFatalHarnessError,
  canFallbackToRun,
} from "./logic.js";

const cfg = loadConfig();

// ── STT concurrency (S4) ──────────────────────────────────────────────
let sttRunning = 0;
const STT_CONCURRENCY = 2;
const sttWaiters: Array<() => void> = [];
async function withSttSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (sttRunning >= STT_CONCURRENCY) await new Promise<void>((r) => sttWaiters.push(r));
  sttRunning++;
  try {
    return await fn();
  } finally {
    sttRunning--;
    const w = sttWaiters.shift();
    if (w) w();
  }
}

// ── harness retry (S3) ───────────────────────────────────────────────
async function withHarnessRetry<T>(label: string, fn: () => Promise<T>, retries = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isFatalHarnessError(e)) throw e;
      if (i === retries) break;
      console.warn(`[harness] ${label} attempt ${i}/${retries} failed: ${e instanceof Error ? e.message : String(e)}; retrying`);
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw last;
}

// ── durable pruning (S5) ─────────────────────────────────────────────
function pruneVoiceDurables(): void {
  try {
    const dir = join(cfg.workDir, ".jcode-media", "telegram-voice");
    if (!existsSync(dir)) return;
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 3600 * 1000;
    const maxBytes = 500 * 1024 * 1024;
    const entries: string[] = readdirSync(dir);
    type Ent = { name: string; mtime: number; size: number };
    const items: Ent[] = [];
    let total = 0;
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > maxAgeMs) {
          try { unlinkSync(p); } catch {} // best-effort prune: next sweep retries
          continue;
        }
        items.push({ name, mtime: st.mtimeMs, size: st.size });
        total += st.size;
      } catch {} // prune scan failures are non-fatal; retried hourly
    }
    if (total > maxBytes) {
      items.sort((a, b) => a.mtime - b.mtime);
      for (const it of items) {
        if (total <= maxBytes) break;
        try { unlinkSync(join(dir, it.name)); total -= it.size; } catch {} // already gone is fine
      }
      console.log(`[prune] voice durables pruned to ${(total / 1024 / 1024).toFixed(1)}MB`);
    }
  } catch (e) {
    console.warn("[prune] voice prune failed:", e);
  }
}

async function warmupStt(): Promise<void> {
  if (!cfg.stt.enabled) return;
  const t0 = Date.now();
  // B-01: warm the RESIDENT worker (model stays loaded in stt_worker.py), so
  // the first real voice note skips both spawn and model load. The old
  // throwaway-process preload only warmed the OS page cache; the resident
  // worker makes the warmup actually bind to the serving path. If resident
  // startup fails, transcribeAudio still falls back to spawn-per-request.
  try {
    const ok = await warmupResident();
    if (ok) {
      console.log(`[stt] resident worker warm in ${Date.now() - t0}ms`);
    } else {
      console.error(
        `[stt] resident warmup FAILED after ${Date.now() - t0}ms (see [stt] logs above); will fall back to per-request python`,
      );
    }
  } catch (e) {
    console.warn(`[stt] warmup failed after ${Date.now() - t0}ms:`, e);
  }
}

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

// P-01 (boot unblock): don't top-level-await connectWithRetry — that left the
// bot deaf for 0-30s at every boot while handlers/polling were already
// registrable. Instead create a promise-gated proxy: handlers and pollLoop
// start immediately; each first use of `client` awaits `clientReady`. On
// failure the waiter gets a fatal error -> systemd restart (same semantics as
// before), or replies "harness connecting" where a throw isn't handled.
let client!: JcodeClient;
let resolveClient!: (c: JcodeClient) => void;
let rejectClient!: (e: unknown) => void;
const clientReady = new Promise<JcodeClient>((res, rej) => {
  resolveClient = res;
  rejectClient = rej;
});
const connectPromise = connectWithRetry().then(
  (c) => {
    client = c;
    store.setClient(c); // ctor captured undefined (async connect) — backfill now
    resolveClient(c);
    attachClientLifecycle(c);
    return c;
  },
  (err) => {
    rejectClient(err);
    throw err;
  },
);
connectPromise.catch((err) => {
  console.error("[bridge] harness connect failed permanently:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
/** Await the connected harness client; user-facing callers get a friendly message on timeout. */
async function waitForClient(): Promise<JcodeClient> {
  // The timeout promise must never dangle: clear its timer when the race
  // settles and attach a no-op catch so a late rejection can't surface as an
  // unhandledRejection (charter: zero unhandled rejections).
  let cancelTimer: () => void = () => undefined;
  const timeout = new Promise<never>((_, rej) => {
    const t = setTimeout(() => rej(new Error("harness connecting, try again")), 15_000);
    cancelTimer = () => clearTimeout(t);
  });
  timeout.catch(() => undefined); // handled-late no-op
  try {
    return await Promise.race([clientReady, timeout]);
  } finally {
    cancelTimer();
  }
}

const store = new SessionStore(client, cfg);
const renderer = new TurnRenderer({ disableLinkPreviews: cfg.disableLinkPreviews });

const openModelPicker = async (chatId: number, replyTo?: number): Promise<void> => {
  const c = await waitForClient();
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
  // w2 stability: bounded pre-mortem snapshot so post-mortem diagnosis does
  // not depend on journal archaeology. Best-effort: never blocks the exit.
  try {
    const snapshot = {
      at: new Date().toISOString(),
      reason,
      uptimeMs: Math.round(process.uptime() * 1000),
      mem: process.memoryUsage().rss,
      activeTurns: activeTurns.size,
      lastAttachSession,
    };
    writeFileAtomic(join(dirname(cfg.stateFile), "fatal-snapshot.json"), JSON.stringify(snapshot, null, 2), 0o600);
  } catch { /* snapshot is advisory only */ }
  process.exit(1);
}

let lastAttachSession: string | undefined;
// P-01: lifecycle listeners must attach in the same tick the client is
// created — any window where "close" fires unobserved would idle forever on a
// dead socket. connectWithRetry().then() resolves on a later microtask, so
// this runs synchronously inside it, before anything else can touch the client.
function attachClientLifecycle(c: JcodeClient): void {
c.on("error", (err: unknown) => {
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
// S-02: a poisoned-session close races in-flight turns. Exiting instantly
// strands those turns on dead child sockets until their ~10min watchdog fires
// (user sees silence). When turns are active we grant a short bounded grace so
// their fast-fail paths run (children share the closed transport), then exit
// for the systemd restart. Double-exit is impossible: fatalExit is
// process.exit, and a re-entered grace clears any pending timer first.
let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
c.on("close", () => {
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
  if (activeTurns.size > 0) {
    console.warn(
      `[bridge] connection closed with ${activeTurns.size} active turn(s); granting 5s grace before exit`,
    );
    if (closeGraceTimer) clearTimeout(closeGraceTimer);
    closeGraceTimer = setTimeout(
      () => fatalExit("harness connection closed (5s turn grace elapsed)"),
      5_000,
    );
    return;
  }
  fatalExit("harness connection closed");
});
}

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

/**
 * M-01b: bounded Map insert. These caches only serve /retry and the batched
 * flush of the NEXT message; keeping unbounded per-chat entries forever is a
 * slow leak (one entry per chat ever seen). Insertion-ordered eviction: at
 * cap, the OLDEST inserted key is dropped. Re-inserting an existing key does
 * not evict anything and keeps its original position (Map semantics), which
 * matches "oldest chat gets forgotten first".
 */
const CACHE_CAP = 64;
function cappedSet<V>(map: Map<number, V>, key: number, value: V, cap = CACHE_CAP): void {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
// Quiet-period text aggregation for >4096 message splits (C14).
const textBatcher = new TextBatchAggregator(
  (chatId, text) => {
    const ctx = lastCtx.get(chatId);
    if (ctx) void route(ctx, text).catch(routeCatchLog);
  },
  { maxWaitMs: 800, hardCapMs: 10_000 },
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
    writeFileAtomic(HOME_FILE, JSON.stringify({ chatId }), 0o600);
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
    if (last)
      void route({ chat: { id: chatId }, message: { message_id: undefined } } as never, last).catch(
        routeCatchLog,
      );
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
  // SEC-01: picker buttons reach client.setModel — they must not be pressable
  // by arbitrary group members.
  if (!allowed(ctx.from?.id)) return;
  void handleModelPickerCallback(bot, client, ctx).catch((err) => {
    console.error("[bridge] callback error:", err);
  });
});

bot.on("text", async (ctx) => {
  const chat = ctx.chat;
  const fromId = ctx.from?.id;
  if (!chat || !fromId) return;
  // SEC-02: cache writes happen only AFTER the auth gate — unauthenticated
  // messages must never grow renderer/lastCtx caches (unbounded pre-auth maps).
  if (!allowed(fromId)) {
    console.log(`[bridge] ignored message from non-allowed user ${fromId}`);
    return;
  }
  renderer.cacheContext(chat.id, ctx);
  cappedSet(lastCtx, chat.id, ctx);
  if (cfg.chatOnly && chat.type !== "private") {
    console.log(`[bridge] ignored ${chat.type} message (chat-only mode) from ${fromId}`);
    return;
  }
  // Long-message chunk aggregation (C14): commands go straight to route(),
  // plain text is quiet-period batched so >4096 splits arrive as one turn.
  const deliver = (text: string) => {
    if (text.trim().startsWith("/")) {
      void route(ctx, text).catch(routeCatchLog);
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

// P4: minimal structural type for media handlers — only the fields the
// voice/document path actually reads. Telegraf's full Context stays at the
// bot.on() call sites; these helpers never touch update machinery.
interface MediaContext {
  chat?: { id: number; type?: string };
  from?: { id: number };
  message?: {
    message_id?: number;
    caption?: string;
    voice?: { file_id: string; file_size?: number };
    audio?: { file_id: string; file_size?: number };
    video_note?: { file_id: string; file_size?: number };
    document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
  };
  /** Only these telegram methods are used on the media path (events.ts renderers). */
  telegram: Pick<Telegram, "getFile" | "sendMessage" | "editMessageText">;
  /** ST-04 prefetch stash (set by handlers, consumed in route()). */
  __sessionPrefetch?: Promise<unknown>;
}

function mediaDeliver(chatId: number, ctx: MediaContext, text: string, immediate = false): void {
  if (cfg.chatOnly && ctx.chat?.type !== "private") return;
  cappedSet(lastCtx, chatId, ctx);
  renderer.cacheContext(chatId, ctx);
  // ST-03: single-part deliveries that gain nothing from batching (voice
  // transcripts) flush immediately instead of idling out the quiet window.
  if (immediate) textBatcher.pushNow(chatId, text);
  else textBatcher.push(chatId, text);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function handleDocument(ctx: MediaContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const fromId = ctx.from?.id;
  if (!chatId || !allowed(fromId)) return;
  // ST-04: fire-and-forget session prefetch, same rationale as handleVoice —
  // the inline-doc fetch below can take seconds; overlap the daemon
  // round-trip with it. Set unconditionally at entry so every downstream
  // mediaDeliver->route() turn body can await it (see ordering proof there).
  const sessionPrefetch = store.getOrCreateSafe(chatId).catch(() => undefined);
  ctx.__sessionPrefetch = sessionPrefetch;
  const doc = ctx.message?.document;
  if (!doc) return;
  const name = doc.file_name ?? "document";
  const size = doc.file_size ?? 0;
  const caption = ctx.message?.caption ?? "";
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
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    mediaDeliver(
      chatId,
      ctx,
      `[Content of ${name}]:\n${content}${caption ? `\n\nCaption: ${caption}` : ""}`,
      true, // inline docs are also single-part deliveries: skip the quiet wait
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
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading voice`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Voice content is private user data: 0600 file / 0700 dir, never world-readable.
  writeFileSync(tmpPath, buf, { mode: 0o600 });
  // durable copy for the agent (tmp is deleted after STT; hermes keeps download dir)
  const durableDir = join(cfg.workDir, ".jcode-media", "telegram-voice");
  try {
    mkdirSync(durableDir, { recursive: true, mode: 0o700 });
    // w1 review: mode only applies to newly-created leaves; force pre-existing dirs too.
    chmodSync(durableDir, 0o700);
  } catch (e) { console.error("[bridge] durable dir prep failed:", e); } // non-fatal: durable write below re-logs
  const rawBase = (file.file_path.split("/").pop() ?? `voice-${Date.now()}${ext}`).split("?")[0];
  const durableName = `${Date.now()}-${randomBytes(6).toString("hex")}-${baseName(rawBase)}`;
  const finalDurable = durableName.includes(".") ? durableName : `${durableName}${ext}`;
  const durablePath = join(durableDir, finalDurable);
  try { writeFileSync(durablePath, buf, { mode: 0o600 }); } catch (e) { console.error("[bridge] durable write failed:", e); }
  return { path: tmpPath, ext, durablePath };
}

async function handleVoice(ctx: MediaContext, kind: "voice" | "audio" | "video_note"): Promise<void> {
  const chatId = ctx.chat?.id;
  const fromId = ctx.from?.id;
  if (!chatId || !allowed(fromId)) return;
  if (cfg.chatOnly && ctx.chat?.type !== "private") return;
  if (!cfg.chatOnly || ctx.chat?.type === "private") {
    renderer.cacheContext(chatId, ctx);
    cappedSet(lastCtx, chatId, ctx);
  }

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

  // ST-04: the session lookup has ZERO dependency on user input (download,
  // STT, caption — none of it feeds getOrCreate). Fire-and-forget prefetch so
  // the daemon round-trip overlaps download+transcription instead of serializing
  // after it inside route()'s queue. Consumed in route(); see the ordering
  // proof there for why awaiting it inside the turn cannot deadlock.
  const sessionPrefetch = store.getOrCreateSafe(chatId).catch(() => undefined);
  ctx.__sessionPrefetch = sessionPrefetch;

  let tmpPath: string | null = null;
  let durableVoicePath: string | null = null;
  try {
    const dl = await downloadTelegramFile(fileId);
    if (!dl) throw new Error("getFile returned no file_path");
    tmpPath = dl.path;
    durableVoicePath = (dl as any).durablePath as string | null;
    // transcribe with bridge stt config (zh/small by default) — gated by concurrency (S4)
    const sttCfg = { enabled: cfg.stt.enabled, echoTranscripts: cfg.stt.echoTranscripts, provider: cfg.stt.provider, language: cfg.stt.language, localModel: cfg.stt.localModel } as any;
    const t0 = Date.now();
    const res = await withSttSlot(() => transcribeAudio(tmpPath!, sttCfg));
    console.log(`[stt] ${kind} ${res.success ? "ok" : "fail"} provider=${res.provider} dur=${Date.now() - t0}ms`);
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
    if (tmpPath) { try { const { unlinkSync } = await import("node:fs"); unlinkSync(tmpPath); } catch {} } // already-deleted tmp is fine
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

// Fire-and-forget route() callers must still observe rejections (charter:
// zero unhandled rejections). handleCommand/turn errors that escape the
// queue-level catch land here, logged with context.
function routeCatchLog(err: unknown): void {
  console.error(
    "[route] unhandled route failure:",
    err instanceof Error ? err.message : String(err),
  );
}

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
  cappedSet(lastUserTexts, chatId, trimmed);
  const userMsgId = ctx.message?.message_id;
  void store.enqueue(
    chatId,
      async () => {
        // P-01: first harness use in a turn waits for the lazy connect; if
        // it's still not up after 15s tell the user instead of hanging silently.
        try {
          await waitForClient();
        } catch (err) {
          throw new Error(
            `harness connecting, try again (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        // -- session lookup + attach (serialized per chat) -----------------
        // ST-04: consume the handler-entry session prefetch (voice/document
        // paths set ctx.__sessionPrefetch). Ordering proof that this await
        // cannot deadlock and the prefetch can never land AFTER this turn:
        //   1. Handlers run OUTSIDE every queue. At entry they call
        //      getOrCreateSafe -> store.enqueue(chatId, prefetchTask): the
        //      prefetch is task A, appended to the per-chat FIFO tail.
        //   2. This turn body becomes task B, enqueued strictly LATER — for
        //      voice only after download+STT complete and the immediate batch
        //      flush invokes route(). SessionStore.enqueue chains via
        //      prev.then(fn), so arrival order == execution order.
        //   3. Hence A finishes before B starts; when this line executes the
        //      prefetch promise is already settled and `await` returns on the
        //      microtask queue. The .catch(() => undefined) at creation means
        //      it can never reject into the turn.
        //   4. No interleaving exists that would order A after B within one
        //      message's lifetime: only the message's own handler creates the
        //      prefetch, synchronously before any await. Competing enqueues
        //      from OTHER events (commands, other chats' messages) may slot
        //      between A and B — they just delay both equally, order intact.
        //   5. Worst case the prefetch failed (daemon down): getOrCreate below
        //      retries with harness backoff exactly as before.
        // getOrCreate still runs: it now hits the warm path (chats[key] was
        // populated by the prefetch) instead of a second daemon round-trip.
        const sessionPrefetch: Promise<unknown> | undefined = (ctx as any).__sessionPrefetch;
        if (sessionPrefetch) await sessionPrefetch;
        let st = await withHarnessRetry("getOrCreate", () => store.getOrCreate(chatId));
        try {
          await withHarnessRetry("attach", () => client.attachSession(st.sessionId));
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
        st = await withHarnessRetry("getOrCreate(retry)", () => store.getOrCreate(chatId));
        if (st.mode !== mode) {
          st = { ...st, mode };
          store.set(chatId, st);
        }
        await withHarnessRetry("attach(retry)", () => client.attachSession(st.sessionId));
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
// P-02: the sync pre-poll prune blocked boot 0.2-2s at 28K durables. Defer it
// 30s past startup and repeat hourly; unref so it never holds the process open.
setTimeout(() => pruneVoiceDurables(), 30_000).unref();
setInterval(() => pruneVoiceDurables(), 3600_000).unref();

// w1 review follow-up: a crash between voice tmp write and cleanup leaves
// private audio in /tmp indefinitely. Sweep stale files (1h+) at startup.
{
  const { readdirSync: _rd, unlinkSync: _ul, statSync: _st } = await import("node:fs");
  const tmpdir = (await import("node:os")).tmpdir();
  try {
    const cutoff = Date.now() - 3_600_000;
    for (const name of _rd(tmpdir)) {
      if (!name.startsWith("jcode-voice-")) continue;
      const p = join(tmpdir, name);
      try {
        if (_st(p).mtimeMs < cutoff) { _ul(p); console.log(`[bridge] swept stale voice tmp: ${name}`); }
      } catch { /* concurrently removed */ }
    }
  } catch { /* best-effort hygiene */ }
}
void warmupStt();

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
    // S-03/S-04: atomic durable write — a torn offset (e.g. '90627521' from
    // '906275210') replays ALL updates after restart; tmp+fsync+rename can't tear.
    writeFileAtomic(cfg.offsetFile, String(offset), 0o600);
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
  const errLog = new PollErrorLogger("getUpdates");
  let errLogHourWarned = -1;
  while (true) {
    let updates: { update_id: number }[];
    try {
      updates = await getUpdatesRaw(cfg.botToken, offset, AbortSignal.timeout(45_000));
      const recovery = errLog.recover(Date.now());
      if (recovery) console.log(recovery.line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const v = errLog.fail(msg, Date.now());
      if (v.shouldLog) console.error(v.line);
      // P2: escalate when the trailing hour is packed with failures — that
      // is a degraded network path (proxy chain/DNS), not isolated blips.
      {
        const hourFailures = errLog.failuresInWindow(Date.now());
        const hour = Math.floor(Date.now() / 3_600_000);
        if (hourFailures >= 10 && hour !== errLogHourWarned) {
          errLogHourWarned = hour;
          console.warn(
            `[bridge] NETWORK HEALTH: ${hourFailures} getUpdates failures in the last hour — check proxy chain/DNS if this persists`,
          );
        }
      }
      if (v.attempts >= FATAL_ATTEMPTS) {
        fatalExit(`getUpdates failed ${v.attempts}x: ${msg}`);
      }
      await sleep(Math.min(3000 * v.attempts, 15000));
      continue;
    }
    if (updates.length > 0) {
      // S-00: advance the offset immediately, but persist it only AFTER the
      // handleUpdate batch resolves. Persisting first meant a crash between
      // save and handling permanently dropped confirmed-but-unprocessed
      // updates (silent loss). At-least-once beats at-most-once: worst case
      // after a mid-batch crash is a rare duplicate reply, never lost updates.
      offset = advanceOffset(updates, offset);
      await Promise.all(
        updates.map((u) => bot.handleUpdate(u as never).catch((e: unknown) => {
          console.error("[bridge] handleUpdate error:", e);
        })),
      );
      saveOffset(offset);
    }
  }
}

void pollLoop(bot).catch((err) => {
  console.error("[bridge] poll loop fatal:", err);
  process.exit(1);
});
