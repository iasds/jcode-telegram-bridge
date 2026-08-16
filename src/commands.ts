import type { JcodeClient } from "@1jehuang/jcode-sdk";
import type { Context } from "telegraf";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { formatMessage, stripMdv2, escapeMdv2 } from "./markdown.js";
import type { SessionStore } from "./sessions.js";
import type { TurnRenderer } from "./events.js";

const HELP = `
*Jcode Telegram Bridge*

/start Welcome and status
/help This help
/status Bridge and daemon status (bridge-only)
/info Current session runtime info (provider / model)
/clear Clear the current session history
/plan Toggle plan mode (plan only, no execution)
/model [name] View or switch model
/compact Request long-context compression
/cancel Interrupt the current turn
/undo Undo the last turn
/title <name> Title this chat's session
/sessions List daemon sessions
/resume <id> Attach a different session
/retry Re-run your last message
/sethome Set this chat as home channel
/platform Platform connection status
/background <prompt> Run in a separate background session
/steer <text> Inject a hint between tool calls
/restart Restart the bridge process
/update git pull + rebuild + restart

Any other text message is sent directly to the jcode agent.
`.trim();

/** Bridge-owned callbacks the command layer needs (kept in one object to avoid parameter sprawl). */
export interface BridgeHooks {
  openModelPicker?: (chatId: number, replyTo?: number) => Promise<void>;
  cancelTurn?: (chatId: number) => void;
  /** Number of in-flight streaming turns right now (0 when idle). */
  activeTurns?: () => number;
  /** Last non-command text this chat sent (for /retry). */
  lastUserText?: (chatId: number) => string | undefined;
  /** Re-route the last user message for this chat (for /retry). */
  retryLast?: (chatId: number) => void;
  /** Persisted home channel for this chat (for /sethome). */
  homeChat?: {
    set: (chatId: number) => void;
    get: () => number | undefined;
  };
}

/**
 * Handle slash commands. Returns true when the message was a handled command.
 */
export async function handleCommand(
  ctx: Context,
  raw: string,
  client: JcodeClient,
  store: SessionStore,
  renderer: TurnRenderer,
  cfg: Config,
  hooks: BridgeHooks = {},
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  const name = ctx.from?.first_name ?? "";
  const reply = (text: string) =>
    ctx.reply(formatMessage(text), { parse_mode: "MarkdownV2" }).catch(() =>
      ctx.reply(stripMdv2(text)),
    );

  const m = raw.match(/^\/(\w+)(?:@\w+)?(?:[ \t]+(.*))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();

  switch (cmd) {
    case "start":
      await reply(`Welcome, ${escapeMdv2(name)}! I am the Telegram entry point to local jcode.\n\n${HELP}`);
      return true;

    case "help":
      await reply(HELP);
      return true;

    case "status": {
      try {
        const sessions = await client.listSessions();
        await client.ping();
        let offset: string | null = null;
        try {
          offset = readFileSync(cfg.offsetFile, "utf8").trim();
        } catch {
          /* offset file not written yet */
        }
        const depths = store.allQueueDepths().map(([c, d]) => `${c}:${d}`).join(", ") || "none";
        const active = hooks.activeTurns ? hooks.activeTurns() : -1;
        await reply(
          `*Status*\nBridge: running\ndaemon: online\nPersistent sessions: ${sessions.length}\nBound Telegram chats: ${store.all().length}\nPoll offset: ${offset ?? "n/a"}\nQueue depth: ${escapeMdv2(depths)}\nActive turns: ${active}`,
        );
      } catch (err) {
        await reply(`*Status*\ndaemon connection failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "info": {
      const st = await store.getOrCreate(chatId);
      try {
        await client.attachSession(st.sessionId);
        const rt = await client.getRuntimeInfo(st.sessionId);
        await reply(
          `*Session info*\nserver:\`${escapeMdv2(rt.server)}\`\nprotocol:v${rt.protocolVersion}\nprovider:\`${escapeMdv2(String(rt.provider))}\`\nmodel:\`${escapeMdv2(String(rt.model ?? "?"))}\`\nworkdir:\`${escapeMdv2(st.workdir)}\`\nplan mode: ${st.mode === "plan" ? "on" : "off"}`,
        );
      } catch (err) {
        await reply(`Failed to get runtime info: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "clear": {
      const st = store.get(chatId);
      if (!st) {
        await reply("No session for this chat yet. Send a message first.");
        return true;
      }
      try {
        await client.attachSession(st.sessionId);
        await client.clear(st.sessionId);
        await reply("✅ Session history cleared.");
      } catch (err) {
        await reply(`Clear failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "plan": {
      const st = await store.getOrCreate(chatId);
      const next = st.mode === "plan" ? "normal" : "plan";
      store.set(chatId, { ...st, mode: next });
      await reply(
        next === "plan"
          ? "🧭 *Plan mode* enabled: messages will only produce a plan — no tools, no file changes. Send /plan again to exit."
          : "✅ Plan mode disabled, normal execution restored.",
      );
      return true;
    }

    case "model": {
      const st = await store.getOrCreate(chatId);
      try {
        await client.attachSession(st.sessionId);
        const catalog = await client.listModels(st.sessionId);
        const current = catalog.current ?? "?";
        if (!arg) {
          if (hooks.openModelPicker) {
            await hooks.openModelPicker(chatId, ctx.message?.message_id);
            return true;
          }
          const list = (catalog.models ?? [])
            .slice(0, 20)
            .map((mo) => `\`${escapeMdv2(String(mo))}\``)
            .join(" ");
          const total = (catalog.models ?? []).length;
          await reply(
            `*Model*\nCurrent:\`${escapeMdv2(String(current))}\`\nAvailable (${total}):${list}${total > 20 ? " …" : ""}\nUsage: /model <name> to switch`,
          );
        } else {
          await client.setModel(st.sessionId, arg);
          await reply(`✅ Switched to \`${escapeMdv2(arg)}\`.`);
        }
      } catch (err) {
        await reply(`Model operation failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "compact": {
      const st = store.get(chatId);
      if (!st) {
        await reply("No session for this chat yet.");
        return true;
      }
      try {
        await client.attachSession(st.sessionId);
        await client.compact(st.sessionId);
        await reply("🧹 Compression requested (async).");
      } catch (err) {
        await reply(`Compression request failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "cancel": {
      const st = store.get(chatId);
      if (!st) {
        await reply("No turn to cancel.");
        return true;
      }
      try {
        await client.attachSession(st.sessionId);
        await client.cancel(st.sessionId);
      } catch (err) {
        await reply(`Cancel failed: ${escapeMdv2(String(err))}`);
        return true;
      }
      // Also tear down the in-flight stream child so the events() loop
      // unwinds immediately instead of waiting for turn_done.
      hooks.cancelTurn?.(chatId);
      await reply("⏹ Cancel request sent.");
      return true;
    }

    case "undo": {
      const st = store.get(chatId);
      if (!st) {
        await reply("No session to undo yet. Send a message first.");
        return true;
      }
      try {
        await client.attachSession(st.sessionId);
        await client.rewindUndo(st.sessionId);
        await reply("⏪ Undone — rewound to the previous state.");
      } catch (err) {
        await reply(`Undo failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "title": {
      const st = await store.getOrCreate(chatId);
      try {
        await client.attachSession(st.sessionId);
        if (!arg) {
          await reply("Usage: /title <name> — set this chat's session title.");
          return true;
        }
        await client.renameSession(st.sessionId, arg);
        await reply(`✅ Session titled \`${escapeMdv2(arg)}\`.`);
      } catch (err) {
        await reply(`Title failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "sessions": {
      try {
        const sessions = await client.listSessions();
        const lines = sessions
          .slice(0, 20)
          .map((s) => {
            const id = String((s as { session_id?: unknown }).session_id ?? s);
            return `\`${escapeMdv2(id.slice(0, 28))}\``;
          })
          .join("\n");
        await reply(`*Sessions* (${sessions.length})\n${lines || "(none)"}\n\nUsage: /resume <session-id>`);
      } catch (err) {
        await reply(`List failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "resume": {
      if (!arg) {
        await reply("Usage: /resume <session-id> (see /sessions).");
        return true;
      }
      const st = await store.getOrCreate(chatId);
      store.set(chatId, { ...st, sessionId: arg });
      await reply(`✅ Switched this chat to session \`${escapeMdv2(arg)}\`.`);
      return true;
    }

    case "retry": {
      const last = hooks.lastUserText?.(chatId);
      if (!last) {
        await reply("No previous message to retry.");
        return true;
      }
      hooks.retryLast?.(chatId);
      await reply("🔁 Retrying your last message…");
      return true;
    }

    case "sethome": {
      hooks.homeChat?.set(chatId);
      await reply("🏠 Home channel set to this chat.");
      return true;
    }

    case "platform": {
      let offset: string | null = null;
      try {
        offset = readFileSync(cfg.offsetFile, "utf8").trim();
      } catch {
        /* not written yet */
      }
      await reply(
        `*Platform*\nTelegram: connected (long-poll, timeout 15s)\nPoll offset: ${offset ?? "n/a"}\nActive turns: ${hooks.activeTurns ? hooks.activeTurns() : -1}`,
      );
      return true;
    }

    case "background": {
      if (!arg) {
        await reply("Usage: /background <prompt> — run in a separate background session.");
        return true;
      }
      const st = await store.getOrCreate(chatId);
      try {
        await client.attachSession(st.sessionId);
        const bg = await client.createSession(st.workdir);
        await client.attachSession(bg.session_id);
        await client.sendMessage(bg.session_id, arg, { waitForAccept: false });
        void (async () => {
          let out = "";
          const consume = (async () => {
            for await (const ev of client.events(bg.session_id)) {
              if (ev.ev === "text_delta") out += ev.text;
              if (ev.ev === "turn_done") return;
            }
          })();
          try {
            await Promise.race([
              consume,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("background turn timed out (120s)")), 120_000),
              ),
            ]);
            await renderer.safeSendMessage(chatId, `🔁 *Background result*\n${out.trim() || "(no output)"}`);
          } catch (err) {
            await renderer.safeSendMessage(chatId, `⚠️ Background failed: ${String(err)}`);
          }
        })();
        await reply(`🚀 Background turn started (session \`${bg.session_id.slice(0, 16)}…\`).`);
      } catch (err) {
        await reply(`Background failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "steer": {
      if (!arg) {
        await reply("Usage: /steer <text> — inject a hint between tool calls.");
        return true;
      }
      const st = store.get(chatId);
      if (!st) {
        await reply("No active session. Send a message first.");
        return true;
      }
      try {
        await client.attachSession(st.sessionId);
        await client.softInterrupt(st.sessionId, arg);
        await reply("🎛 Steer injected.");
      } catch (err) {
        await reply(`Steer failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    case "restart": {
      await reply("🔄 Restarting bridge…");
      setTimeout(() => process.exit(0), 800); // systemd Restart=always brings it back
      return true;
    }

    case "update": {
      await reply("📦 Updating (git pull + rebuild)…");
      const { execFile } = await import("node:child_process");
      execFile(
        "bash",
        ["-lc", `cd "${process.cwd()}" && git pull --ff-only && npm ci --silent && npm run build`],
        { timeout: 180_000 },
        (err, stdout, stderr) => {
          if (err) {
            void renderer
              .safeSendMessage(chatId, `⚠️ Update failed: ${escapeMdv2(String(err))}\n${escapeMdv2(String(stderr).slice(-500))}`)
              .catch(() => undefined);
            return;
          }
          void renderer
            .safeSendMessage(chatId, `✅ Updated (${String(stdout).slice(-200)})\nRestarting…`)
            .then(() => setTimeout(() => process.exit(0), 800))
            .catch(() => process.exit(0));
        },
      );
      return true;
    }

    default:
      return false;
  }
}

