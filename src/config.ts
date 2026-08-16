import "dotenv/config";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Config {
  botToken: string;
  allowedIds: number[];
  workDir: string;
  stateFile: string;
  /** Derived from stateFile's directory: persisted Telegram poll offset. */
  offsetFile: string;
  turnTimeoutMs: number;
  /** Max turns queued per chat (running + pending). */
  queueLimit: number;
  planPrompt: string;
  planModePrefix: string;
  disableLinkPreviews: boolean;
  /** React 👀/✅/❌ to user messages while processing (default off). */
  enableReactions: boolean;
  /** Only respond in private chats; ignore all groups/channels. */
  chatOnly: boolean;
}

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required (see .env)");
  }
  const home = homedir();
  const workDir = process.env.WORKING_DIR
    ? join(process.env.WORKING_DIR)
    : home;
  const stateFile =
    process.env.STATE_FILE ?? join(home, "jcode-telegram-bridge", "state.json");

  return {
    botToken: token,
    allowedIds: parseIds(process.env.TELEGRAM_BOT_ALLOWED_IDS),
    workDir,
    stateFile,
    offsetFile: join(dirname(stateFile), "poll-offset.txt"),
    turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS ?? 10 * 60 * 1000),
    queueLimit: Number(process.env.QUEUE_LIMIT ?? 5),
    planPrompt:
      process.env.PLAN_PROMPT ??
      "[Plan mode] Only output an execution plan (step list, files involved, risks). Do not run any tools, do not modify any files. Wait for user confirmation before executing.",
    planModePrefix:
      process.env.PLAN_MODE_PREFIX ?? "[Plan mode] Plan only, do not execute.",
    disableLinkPreviews: (process.env.DISABLE_LINK_PREVIEWS ?? "").toLowerCase() === "true",
    enableReactions: (process.env.ENABLE_REACTIONS ?? "").toLowerCase() === "true",
    chatOnly: (process.env.TELEGRAM_CHAT_ONLY ?? "").toLowerCase() === "true",
  };
}
