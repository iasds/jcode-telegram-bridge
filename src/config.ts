import "dotenv/config";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface SttConfig {
  /** STT enabled (STT_ENABLED, default true). */
  enabled: boolean;
  /** Echo transcript back as 🎙️ quote before feeding agent (STT_ECHO_TRANSCRIPTS, default true). */
  echoTranscripts: boolean;
  /** Explicit provider ""=auto, else local/groq/openai (STT_PROVIDER). */
  provider: string;
  /** Language hint, default zh (STT_LANGUAGE / HERMES_LOCAL_STT_LANGUAGE). */
  language: string;
  /** Local faster-whisper model, default small per user choice (STT_LOCAL_MODEL). */
  localModel: string;
}

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
  /** Speech-to-text config (mirrors hermes stt section, defaults small+zh). */
  stt: SttConfig;
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

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined || raw === "") return defaultVal;
  const v = raw.toLowerCase().trim();
  if (["0", "false", "off", "no", "disable", "disabled"].includes(v)) return false;
  if (["1", "true", "on", "yes", "enable", "enabled"].includes(v)) return true;
  return defaultVal;
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
    stt: {
      enabled: parseBool(process.env.STT_ENABLED, true),
      echoTranscripts: parseBool(process.env.STT_ECHO_TRANSCRIPTS, true),
      provider: (process.env.STT_PROVIDER ?? process.env.STT_MODEL_PROVIDER ?? "").trim(),
      language: (process.env.STT_LANGUAGE ?? process.env.HERMES_LOCAL_STT_LANGUAGE ?? "zh").trim() || "zh",
      localModel: (process.env.STT_LOCAL_MODEL ?? "small").trim() || "small",
    },
  };
}
