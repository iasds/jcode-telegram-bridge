/**
 * STT — local speech-to-text via hermes-agent transcription tools.
 *
 * Primary path (B-01): a RESIDENT python worker (`stt_worker.py`, JSON lines
 * over stdin/stdout) keeps the faster-whisper model loaded across requests,
 * eliminating the 1.2-3s/request python spawn+import+model-load overhead.
 * The old spawn-per-request inline path is kept verbatim as a fallback so
 * STT never regresses if the worker cannot run. Both paths delegate real
 * Whisper/VAD/hallucination logic to hermes-agent's transcription_tools
 * (1:1 with hermes-agent behavior; see stt_worker.py for the parity notes).
 *
 * Required at runtime: checkout at ~/.jcode/scratch/hermes-agent (or set
 * HERMES_AGENT_DIR), plus faster-whisper + ffmpeg, and stt_worker.py next to
 * the compiled dist/ (repo root). Env HERMES_LOCAL_STT_LANGUAGE and
 * model="small" give zh/small defaults (hermes defaults are en/base).
 */
import { existsSync, statSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { spawn } from "node:child_process";

export const SUPPORTED_FORMATS = new Set([
  ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm",
  ".ogg", ".oga", ".opus", ".aac", ".flac", ".caf", ".silk",
]);
export const STT_MAX_FILE_BYTES = 25 * 1024 * 1024;

// Resident-worker policy (B-01). Per-job budget matches the old inline spawn
// timeout (180s); a job that misses it rejects the caller but leaves the
// worker running unless a second concurrent timeout fires during the wedge
// grace window, which proves the process is wedged and forces kill+respawn.
export const STT_JOB_TIMEOUT_MS = 120_000;
const STT_INLINE_FALLBACK_TIMEOUT_MS = 180_000;
const STT_WORKER_WEDGE_GRACE_MS = 30_000;

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

/** Models faster-whisper can load here; anything else fails at load time. */
export const VALID_STT_MODELS = ["tiny", "base", "small", "medium", "large-v3"] as const;
const VALID_STT_MODEL_SET = new Set<string>(VALID_STT_MODELS);

/**
 * Resolve STT_LOCAL_MODEL against the known set (README "config hardening"
 * contract): empty -> small, case-normalized, unknown values fall back to
 * small WITH a warning instead of failing later inside faster-whisper with
 * an opaque load error.
 */
export function resolveLocalModel(raw: string | undefined): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "small";
  if (!VALID_STT_MODEL_SET.has(v)) {
    const original = (raw ?? "").trim();
    console.warn(
      `[stt] unknown STT_LOCAL_MODEL '${original}' — falling back to 'small' (supported: ${VALID_STT_MODELS.join("/")})`,
    );
    return "small";
  }
  return v;
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
    localModel: resolveLocalModel(env.STT_LOCAL_MODEL),
  };
}

export function isSupportedAudioExt(p: string): boolean {
  return SUPPORTED_FORMATS.has(extname(p).toLowerCase());
}

function hermesAgentDir(): string {
  return (process.env.HERMES_AGENT_DIR ?? `${process.env.HOME ?? "/home/user"}/.jcode/scratch/hermes-agent`).trim();
}

/**
 * w2 stability: existence + size gate, extracted as a pure-ish unit so the
 * fail-closed branch is directly testable (a stat failure here previously
 * fell through to spawn anyway, wasting a python boot and failing later with
 * an opaque worker error). Returns an error string when the caller must bail,
 * or null when the file is present and within budget.
 */
export function statGate(abs: string): string | null {
  if (!existsSync(abs)) return `file not found: ${abs}`;
  try {
    const st = statSync(abs);
    if (st.size > STT_MAX_FILE_BYTES) return `file too large: ${(st.size / 1024 / 1024).toFixed(1)}MB > 25MB`;
    return null;
  } catch (e) {
    return `stat failed: ${e instanceof Error ? e.message : e}`;
  }
}

export async function transcribeAudio(filePath: string, cfg?: SttConfig): Promise<TranscriptionResult> {
  const scfg = cfg ?? loadSttConfig();
  if (!scfg.enabled) return { success: false, transcript: "", provider: "none", error: "STT disabled" };
  const abs = resolve(filePath);
  const gateErr = statGate(abs);
  if (gateErr) return { success: false, transcript: "", provider: "none", error: gateErr };

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
  // Do NOT force HF_ENDPOINT/HF_HUB_DISABLE_XET: this host reaches
  // huggingface.co through a transparent proxy whose CDN route is fast,
  // while hf-mirror / non-XET paths regress to TLS EOF or ~200KB/s here.
  // Respect whatever the operator configured; no endpoint overrides.
  env.PYTHONPATH = [hermesAgentDir(), env.PYTHONPATH ?? ""].filter(Boolean).join(":");

  const model = scfg.localModel || "small";

  // Resident-worker fast path; spawn-per-request below stays as the
  // never-regress fallback when the worker cannot be spawned/used.
  try {
    return await transcribeViaResident(abs, scfg);
  } catch (e) {
    console.error(`[stt] resident worker unavailable, falling back to inline python: ${e instanceof Error ? e.message : e}`);
    resetSttWorker();
  }
  return await new Promise<TranscriptionResult>((resolveR) => {
    const p = spawn("python3", ["-c", code, abs, model], { env, timeout: STT_INLINE_FALLBACK_TIMEOUT_MS } as any);
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
        } catch {} // JSON parse of inline output failed -> fall through to stderr surfacing below
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

// ---------------------------------------------------------------------------
// Resident STT worker (B-01): one long-lived python process keeps the
// faster-whisper model loaded, eliminating the 1.2-3s/request spawn+import+
// model-load overhead of the inline path above. Protocol: JSON lines both
// ways. Jobs: {"id","path"} transcribe | {"id","op":"load"} preload |
// {"id","op":"ping"}. Replies: {"id","ok",...}. The worker never exits on job
// errors; if the PROCESS dies we reject pendings and self-heal on next use.
// ---------------------------------------------------------------------------

interface ResidentReply {
  id: string;
  ok: boolean;
  transcript?: string;
  error?: string;
  provider?: string;
}

interface PendingJob {
  timer: NodeJS.Timeout;
  resolve: (r: TranscriptionResult) => void;
}

interface SttWorker {
  child: ReturnType<typeof spawn>;
  pending: Map<string, PendingJob>;
  wedgedTimer?: NodeJS.Timeout;
}

let sttWorkerSingleton: SttWorker | null = null;

export function resetSttWorker(): void {
  const w = sttWorkerSingleton;
  sttWorkerSingleton = null;
  if (!w) return;
  if (w.wedgedTimer) clearTimeout(w.wedgedTimer);
  for (const [, p] of w.pending) {
    clearTimeout(p.timer);
    p.resolve({ success: false, transcript: "", provider: "local", error: "STT resident worker is shutting down" });
  }
  w.pending.clear();
  try {
    w.child.kill("SIGTERM"); // python handler finishes current line then exits 0
  } catch {} // kill on dying/already-dead worker is best-effort; close handler rejects pendings
}

function failAllPending(w: SttWorker, why: string): void {
  if (w.wedgedTimer) {
    clearTimeout(w.wedgedTimer);
    w.wedgedTimer = undefined;
  }
  for (const [, p] of w.pending) {
    clearTimeout(p.timer);
    p.resolve({ success: false, transcript: "", provider: "local", error: why });
  }
  w.pending.clear();
}

function wireWorker(w: SttWorker): void {
  let buf = "";
  w.child.stdout?.setEncoding("utf8");
  w.child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let reply: ResidentReply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue; // not protocol output; ignore
      }
      const p = w.pending.get(reply.id);
      if (!p) continue;
      w.pending.delete(reply.id);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve({ success: true, transcript: String(reply.transcript ?? ""), provider: String(reply.provider ?? "local") });
      else p.resolve({ success: false, transcript: "", provider: String(reply.provider ?? "local"), error: reply.error ? String(reply.error).slice(0, 800) : "worker reported failure" });
    }
  });
  const died = (why: string) => {
    if (sttWorkerSingleton === w) sttWorkerSingleton = null; // self-heal: next request respawns
    failAllPending(w, why);
  };
  w.child.on("error", (e) => died(`STT resident worker failed (${e.message})`));
  w.child.on("close", (code, signal) => died(`STT resident worker exited unexpectedly (code=${code}${signal ? ` signal=${signal}` : ""})`));
}

function getSttWorker(scfg: SttConfig): SttWorker {
  if (sttWorkerSingleton) return sttWorkerSingleton;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.HERMES_LOCAL_STT_LANGUAGE && scfg.language) env.HERMES_LOCAL_STT_LANGUAGE = scfg.language;
  env.PYTHONPATH = [hermesAgentDir(), env.PYTHONPATH ?? ""].filter(Boolean).join(":");
  const script = resolve(process.cwd(), "stt_worker.py");
  const child = spawn("python3", [script, scfg.localModel || "small"], {
    env,
    stdio: ["pipe", "pipe", "inherit"], // worker diagnostics flow to our stderr
  });
  child.unref?.();
  const w: SttWorker = { child, pending: new Map() };
  sttWorkerSingleton = w;
  wireWorker(w);
  return w;
}

function sendJob(w: SttWorker, job: Record<string, unknown>, timeoutMs: number): Promise<TranscriptionResult> {
  return new Promise<TranscriptionResult>((resolveP, rejectP) => {
    const id = String(job.id);
    const timer = setTimeout(() => {
      if (!w.pending.delete(id)) return;
      if (w.pending.size === 0) {
        // Worker processed nothing else and missed our deadline: likely wedged
        // (e.g. blocked in a C call). Arm a short fuse; a second concurrent
        // timeout before it fires proves the wedge and forces kill+respawn.
        w.wedgedTimer = setTimeout(() => {
          try {
            w.child.kill("SIGKILL");
          } catch {} // SIGKILL escalation best-effort; process may have exited already
        }, STT_WORKER_WEDGE_GRACE_MS);
        w.wedgedTimer.unref?.();
      }
      rejectP(new Error(`STT resident worker timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    w.pending.set(id, { timer, resolve: resolveP as (r: TranscriptionResult) => void });
    try {
      const stdin = w.child.stdin;
      if (!stdin) throw new Error("STT resident worker has no stdin pipe");
      stdin.write(JSON.stringify(job) + "\n");
    } catch (e) {
      w.pending.delete(id);
      clearTimeout(timer);
      rejectP(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function transcribeViaResident(abs: string, scfg: SttConfig): Promise<TranscriptionResult> {
  const w = getSttWorker(scfg);
  try {
    return await sendJob(w, { id: `t${++sttJobSeq}`, path: abs }, STT_JOB_TIMEOUT_MS);
  } catch (e) {
    // Timeout leaves the singleton alive unless it fired twice concurrently
    // (wedge kill above); spawn/pipe failures land here too via close->reject.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

let sttJobSeq = 0;

/**
 * Preload the resident model without transcribing anything. Non-fatal by
 * contract: resolves true when the worker answered, false otherwise (caller
 * decides whether to care — bridge warmup wiring is coordinator-owned).
 */
export async function warmupResident(timeoutMs = 60_000): Promise<boolean> {
  try {
    const scfg = loadSttConfig();
    if (!scfg.enabled) return false;
    const w = getSttWorker(scfg);
    await sendJob(w, { id: `warmup${++sttJobSeq}`, op: "load" }, timeoutMs);
    return true;
  } catch (e) {
    console.error(`[stt] warmupResident failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
