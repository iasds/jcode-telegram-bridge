import { JcodeClient, HarnessError } from "@1jehuang/jcode-sdk";
import { Telegraf } from "telegraf";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { SessionStore } from "./sessions.js";
import { TurnRenderer } from "./events.js";
import { handleCommand } from "./commands.js";
import { sendModelPicker, handleModelPickerCallback } from "./model-picker.js";
import { StreamingRenderer } from "./stream.js";

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
const FATAL_CODES = new Set(["disconnected", "connect_failed"]);
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
  await handleCommand(ctx, "/start", client, store, renderer, cfg, openModelPicker);
});

bot.help(async (ctx) => {
  if (!allowed(ctx.from?.id)) return;
  renderer.cacheContext(ctx.chat.id, ctx);
  await handleCommand(ctx, "/help", client, store, renderer, cfg, openModelPicker);
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
  if (!allowed(fromId)) {
    console.log(`[bridge] ignored message from non-allowed user ${fromId}`);
    return;
  }
  if (chat.type === "private") {
    await route(ctx, ctx.message.text);
  } else if (chat.type === "group" || chat.type === "supergroup") {
    // Group chats: only respond when the bot is mentioned. Cache the
    // bot username so we don't hit getMe on every group message.
    if (botUsername === undefined) {
      botUsername = (await bot.telegram.getMe().catch(() => undefined))?.username;
    }
    const text = stripMention(ctx.message.text, botUsername);
    if (text && text !== ctx.message.text) {
      await route(ctx, text);
    }
  }
});

async function route(ctx: any, text: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const trimmed = text.trim();

  // Commands first.
  if (trimmed.startsWith("/")) {
    const handled = await handleCommand(ctx, trimmed, client, store, renderer, cfg, openModelPicker);
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

  // Normal turn: queue per session so one session never runs two turns.
  try {
    let st = await store.getOrCreate(chatId);
    try {
      await client.attachSession(st.sessionId);
      lastAttachSession = st.sessionId;
    } catch (err) {
      // Session is missing on the daemon (cleared/pruned/daemon restart) or
      // poisoned (attach makes the daemon reset the socket). Either way drop
      // the stale mapping and recreate so the chat recovers automatically
      // instead of erroring forever. A truly dead connection raises
      // FATAL_CODES and is allowed to propagate to the process-level exit.
      if (err instanceof HarnessError && FATAL_CODES.has(err.code)) throw err;
      console.warn(
        `[route] attach ${st.sessionId.slice(0, 16)}… failed (${err instanceof Error ? err.message : String(err)}); recreating`,
      );
      store.remove(chatId);
      st = await store.getOrCreate(chatId);
      await client.attachSession(st.sessionId);
      lastAttachSession = st.sessionId;
    }
    const content =
      st.mode === "plan" ? `${cfg.planModePrefix}\n${trimmed}` : trimmed;
    const replyTo = ctx.message?.message_id;

    // Fire-and-forget: the turn runs in the background so telegraf can keep
    // processing updates (e.g. /cancel) while the model is still working.
    void store.enqueue(chatId, async () => {
      // Streaming path: a per-turn child connection (same pattern the SDK's
      // globalEvents uses internally) consumes events() reliably, letting the
      // reply stream into Telegram via progressive edits. Falls back to
      // run() only if the turn never started (attach/send failed); if
      // streaming itself fails mid-turn (flood strikes), collect the text
      // and deliver once.
      console.log("[stream] connect");
      const child = await JcodeClient.connect({
        clientName: "jcode-tg-bridge-stream/1.0",
        requestTimeoutMs: cfg.turnTimeoutMs + 30_000,
      });
      console.log("[stream] connected");
      let stream: StreamingRenderer | null = null;
      let working: number | undefined;
      let turnStarted = false;
      let accumulated = "";
      try {
        console.log("[stream] attach", st.sessionId.slice(0, 20));
        await child.attachSession(st.sessionId);
        lastAttachSession = st.sessionId;
        console.log("[stream] attached");
        stream = new StreamingRenderer(bot, chatId, replyTo);
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
        if (stream && !stream.failed) {
          await stream.finish();
          console.log("[stream] finished");
        } else {
          // streaming disabled/never started: deliver collected text once
          if (stream) stream.cancel();
          await renderer.finishWith(chatId, working, accumulated);
        }
      } catch (err) {
        if (err instanceof HarnessError && FATAL_CODES.has(err.code)) {
          fatalExit(`stream failed [${err.code}]: ${err.message}`);
        }
        console.error("[route] stream error:", err);
        if (stream) await stream.cancel();
        if (!turnStarted) {
          // Safe to run() once: the turn never began on the daemon.
          try {
            const result = await client.run(st.sessionId, content, { autoApprove: true });
            const w = working ?? (await renderer.sendWorking(chatId, replyTo));
            await renderer.finishWith(chatId, w, result.text ?? "");
          } catch (err2) {
            if (err2 instanceof HarnessError && FATAL_CODES.has(err2.code)) {
              fatalExit(`run fallback failed [${err2.code}]: ${err2.message}`);
            }
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
        await child.close().catch(() => undefined);
      }
    }).catch((err) => console.error("[route] queue error:", err));
  } catch (err) {
    console.error("[route] EXCEPTION:", err);
    const msg = err instanceof HarnessError ? `jcode error [${err.code}]: ${err.message}` : String(err);
    await renderer.safeSendMessage(chatId, `⚠️ ${msg}`, ctx.message?.message_id);
  }
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
 * short 5s Telegram-side poll keeps every request short-lived.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Persisted poll offset: on restart we must NOT re-pull already-delivered
// updates (getUpdates(offset=0) returns every unconfirmed update again, so a
// crash/restart loop would re-handle the same message and re-send the same
// reply — the "bot loops sending the same message" bug).
const OFFSET_FILE = join(homedir(), "jcode-telegram-bridge", "poll-offset.txt");
function loadOffset(): number {
  try {
    const n = Number(readFileSync(OFFSET_FILE, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function saveOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, String(offset), { mode: 0o600 });
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
      offset = updates.reduce((max, u) => Math.max(max, u.update_id), 0) + 1;
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
