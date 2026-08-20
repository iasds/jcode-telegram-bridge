/**
 * STT — thin Node wrapper around hermes-agent/tools/transcription_tools.py
 *
 * Does NOT re-implement Whisper/VAD/hallucination logic. Delegates to
 * `transcribe_audio(path, model="small", source="gateway")` so local VAD,
 * no_speech/logprob gates, CUDA fallback, .silk handling, and cloud trim stay
 * 1:1 with hermes-agent.
 *
 * Required at runtime: checkout at ~/.jcode/scratch/hermes-agent (or set
 * HERMES_AGENT_DIR), plus faster-whisper + ffmpeg. Env HERMES_LOCAL_STT_LANGUAGE
 * and model="small" give zh/small defaults (hermes defaults are en/base).
 */
import { existsSync, statSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { spawn } from "node:child_process";

export const SUPPORTED_FORMATS = new Set([
  ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm",
  ".ogg", ".oga", ".opus", ".aac", ".flac", ".caf", ".silk",
]);
export const STT_MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface TranscriptionResult {
  success: boolean;
  transcript: string;
  provider: string;
  error?: string;
}

export interface SttConfig {
  enabled: boolean;
  echoTranscripts: boolean;
  provider: string;
  language: string; // default zh (hermes default en, we override)
  localModel: string; // default small (hermes default base)
}

export function loadSttConfig(env = process.env): SttConfig {
  const enabledRaw = env.STT_ENABLED;
  const enabled = enabledRaw === undefined ? true : !["0", "false", "off", "no"].includes(enabledRaw.toLowerCase());
  const echoRaw = env.STT_ECHO_TRANSCRIPTS;
  const echoTranscripts = echoRaw === undefined ? true : !["0", "false", "off", "no"].includes(echoRaw.toLowerCase());
  return {
    enabled,
    echoTranscripts,
    provider: (env.STT_PROVIDER ?? env.STT_MODEL_PROVIDER ?? "").trim(),
    language: (env.STT_LANGUAGE ?? env.HERMES_LOCAL_STT_LANGUAGE ?? "zh").trim() || "zh",
    localModel: (env.STT_LOCAL_MODEL ?? "small").trim() || "small",
  };
}

export function isSupportedAudioExt(p: string): boolean {
  return SUPPORTED_FORMATS.has(extname(p).toLowerCase());
}

function hermesAgentDir(): string {
  return (process.env.HERMES_AGENT_DIR ?? `${process.env.HOME ?? "/home/user"}/.jcode/scratch/hermes-agent`).trim();
}

export async function transcribeAudio(filePath: string, cfg?: SttConfig): Promise<TranscriptionResult> {
  const scfg = cfg ?? loadSttConfig();
  if (!scfg.enabled) return { success: false, transcript: "", provider: "none", error: "STT disabled" };
  const abs = resolve(filePath);
  if (!existsSync(abs)) return { success: false, transcript: "", provider: "none", error: `file not found: ${abs}` };
  try {
    const st = statSync(abs);
    if (st.size > STT_MAX_FILE_BYTES) return { success: false, transcript: "", provider: "none", error: `file too large: ${(st.size / 1024 / 1024).toFixed(1)}MB > 25MB` };
  } catch {}

  const code = `
import json, sys, os
# ensure hermes import; transcribe_audio handles VAD/silk/decoding/transcode internally
from tools.transcription_tools import transcribe_audio
path = sys.argv[1]
model = sys.argv[2] if len(sys.argv) > 2 else None
# hermes resolves language from config/env; we set HERMES_LOCAL_STT_LANGUAGE in child env
res = transcribe_audio(path, model=model or None, source="gateway")
print(json.dumps(res, ensure_ascii=False))
`.trim();

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Force zh for hermes language resolution (hermes default is en)
  if (!env.HERMES_LOCAL_STT_LANGUAGE && scfg.language) env.HERMES_LOCAL_STT_LANGUAGE = scfg.language;
  // Do NOT force HF_ENDPOINT/HF_HUB_DISABLE_XET: the host is behind
  // sys-mihomo transparent proxy (hermes-agent netvm=sys-mihomo, SELECT=JP-HY2
  // gives ~7MB/s to us.aws.cdn.hf.co via XET). Forcing hf-mirror or disabling
  // XET regresses to TLS EOF / 200KB/s. Respect whatever the operator set.
  env.PYTHONPATH = [hermesAgentDir(), env.PYTHONPATH ?? ""].filter(Boolean).join(":");

  const model = scfg.localModel || "small";

  return await new Promise<TranscriptionResult>((resolveR) => {
    const p = spawn("python3", ["-c", code, abs, model], { env, timeout: 180_000 } as any);
    let out = "";
    let err = "";
    p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => resolveR({ success: false, transcript: "", provider: "local", error: String(e) }));
    p.on("close", (code) => {
      const trimmed = out.trim();
      if (trimmed) {
        try {
          const j = JSON.parse(trimmed.split("\n").filter(Boolean).pop()!);
          // normalize to TranscriptionResult
          resolveR({
            success: !!j.success,
            transcript: String(j.transcript ?? ""),
            provider: String(j.provider ?? "local"),
            error: j.error ? String(j.error) : undefined,
          });
          return;
        } catch {}
      }
      // non-zero or no JSON: surface stderr
      const msg = (err || out).slice(0, 800).trim() || `exit ${code}`;
      resolveR({ success: false, transcript: "", provider: "local", error: msg });
    });
  });
}

/**
 * Mirrors gateway/run.py _enrich_message_with_transcription contract.
 * Successful transcripts become quoted lines; empty/failed becomes the single
 * neutral marker without setup instructions (so history is not poisoned).
 */
export function enrichTextWithTranscript(userText: string, transcripts: string[], audioPathForFallback?: string): string {
  const placeholder = "(The user sent a message with no text content)";
  const parts: string[] = [];
  let hadSuccess = false;
  for (const t of transcripts) {
    const tt = (t || "").trim();
    if (!tt) {
      parts.push("[The user sent a voice message but it came through empty or inaudible — speech-to-text returned no words. Do not guess; ask the user to resend or type it.]");
      hadSuccess = true; // still counts as enrichment, not unavailable
    } else {
      parts.push(`"${tt}"`);
      hadSuccess = true;
    }
  }
  if (!hadSuccess) {
    const note = audioPathForFallback
      ? `[voice message could not be transcribed automatically; the audio is available at: ${audioPathForFallback}]`
      : "[voice message could not be transcribed]";
    if (!userText || userText.trim() === placeholder) return note;
    if (userText) return `${note}\n\n${userText}`;
    return note;
  }
  const prefix = parts.join("\n\n");
  if (!userText || userText.trim() === placeholder) return prefix;
  if (userText) return `${prefix}\n\n${userText}`;
  return prefix;
}
