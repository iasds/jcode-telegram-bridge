import "dotenv/config";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Faster-whisper model ids we actually host / will download. */
export const ALLOWED_STT_MODELS = new Set(["tiny", "base", "small", "medium", "large-v3", "large"] as const);

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

function clampInt(raw: string | undefined, def: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] invalid ${label}=${JSON.stringify(raw)} — using default ${def}`);
    return def;
  }
  const clamped = Math.max(min, Math.min(max, Math.trunc(n)));
  if (clamped !== n) console.warn(`[config] ${label}=${n} clamped to ${clamped}`);
  return clamped;
}

function normalizeSttModel(raw: string | undefined): string {
  const v = (raw ?? "small").trim().toLowerCase() || "small";
  if ((ALLOWED_STT_MODELS as Set<string>).has(v)) return v;
  if (v === "large-v2") return "large-v3";
  console.warn(`[config] unknown STT_LOCAL_MODEL=${JSON.stringify(raw)} — using small`);
  return "small";
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
    turnTimeoutMs: clampInt(process.env.TURN_TIMEOUT_MS, 10 * 60 * 1000, 10_000, 30 * 60 * 1000, "TURN_TIMEOUT_MS"),
    queueLimit: clampInt(process.env.QUEUE_LIMIT, 5, 1, 20, "QUEUE_LIMIT"),
    planPrompt:
      process.env.PLAN_PROMPT ??
      "[Plan mode] Only output an execution plan (step list, files involved, risks). Do not run any tools, do not modify any files. Wait for user confirmation before executing.",
    planModePrefix:
      process.env.PLAN_MODE_PREFIX ?? "[Plan mode] Plan only, do not execute.",
    disableLinkPreviews: parseBool(process.env.DISABLE_LINK_PREVIEWS, false),
    enableReactions: parseBool(process.env.ENABLE_REACTIONS, false),
    chatOnly: parseBool(process.env.TELEGRAM_CHAT_ONLY, false),
    stt: {
      enabled: parseBool(process.env.STT_ENABLED, true),
      echoTranscripts: parseBool(process.env.STT_ECHO_TRANSCRIPTS, true),
      provider: (process.env.STT_PROVIDER ?? process.env.STT_MODEL_PROVIDER ?? "").trim(),
      language: (process.env.STT_LANGUAGE ?? process.env.HERMES_LOCAL_STT_LANGUAGE ?? "zh").trim() || "zh",
      localModel: normalizeSttModel(process.env.STT_LOCAL_MODEL),
    },
  };
}
