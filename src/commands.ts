import type { JcodeClient } from "@1jehuang/jcode-sdk";
import type { Context } from "telegraf";
import type { Config } from "./config.js";
import { formatMessage, stripMdv2, escapeMdv2 } from "./markdown.js";
import type { SessionStore } from "./sessions.js";
import type { TurnRenderer } from "./events.js";

const HELP = `
*Jcode Telegram Bridge*

/start Welcome and status
/help This help
/status Bridge and daemon status (bridge-only, not a TUI command)
/info Current session runtime info (provider / model)
/clear Clear the current session history
/plan Toggle plan mode (plan only, no execution)
/model [name] View or switch model
/compact Request long-context compression
/cancel Interrupt the current turn

Any other text message is sent directly to the jcode agent.
`.trim();

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
  openModelPicker?: (chatId: number, replyTo?: number) => Promise<void>,
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
        await reply(
          `*Status*\nBridge: running\ndaemon: online\nPersistent sessions: ${sessions.length}\nBound Telegram chats: ${store.all().length}`,
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
          if (openModelPicker) {
            await openModelPicker(chatId, ctx.message?.message_id);
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
        await reply("⏹ Cancel request sent.");
      } catch (err) {
        await reply(`Cancel failed: ${escapeMdv2(String(err))}`);
      }
      return true;
    }

    default:
      return false;
  }
}

