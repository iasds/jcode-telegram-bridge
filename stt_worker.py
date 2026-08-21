#!/usr/bin/env python3
"""Resident STT worker for jcode-telegram-bridge.

Long-lived replacement for the spawn-per-request inline python in src/stt.ts:
the faster-whisper model stays loaded across jobs, eliminating the
1.2-3s/request python startup + import + model-load overhead.

Protocol (one JSON object per line):
  stdin  (jobs):     {"id": "...", "path": "/abs/file.oga"}                     -> transcribe
                     {"id": "...", "op": "load"}                                -> preload model
                     {"id": "...", "op": "ping"}                                -> liveness probe
  stdout (replies):  {"id": "...", "ok": true, "transcript": "...", "provider": "local"}
                     {"id": "...", "ok": false, "error": "..."}
  stderr:            free-form diagnostics (never parsed by the Node side).

Guarantees:
- Exactly ONE stdout line per accepted job; flushed immediately.
- A job error NEVER exits the process (errors go to the reply + stderr).
- SIGTERM/SIGINT finish the current job, then exit 0.
- Behavior parity with the previous inline `transcribe_audio(path, model,
  source="gateway")` call: same hermes preprocessing (.silk decode, ffmpeg
  transcode), same anti-hallucination transcribe kwargs via
  build_local_transcribe_kwargs (vad_filter, HERMES_LOCAL_STT_LANGUAGE
  resolution, initial_prompt, confidence thresholds), same segment gating via
  _join_confident_segments. Language intentionally comes from the environment
  (hermes resolution), matching the old inline code which passed no language.
  If hermes is configured for a NON-local provider, the worker transparently
  delegates to the full transcribe_audio pipeline so behavior cannot regress.
"""
import json
import os
import shutil
import signal
import sys
import time
import traceback

MODEL_ARG = sys.argv[1] if len(sys.argv) > 1 else "small"

_PROTOCOL_OUT = sys.stdout  # captured before anything can rebind sys.stdout
_tt = None                  # lazy: tools.transcription_tools
_get_read_block_error = None
_model = None               # resident faster-whisper WhisperModel (cpu, int8)
_model_name = None
_deps_failed_once = False

_running = True


def _log(msg: str) -> None:
    sys.stderr.write(f"[stt_worker] {msg}\n")
    sys.stderr.flush()


def emit(obj: dict) -> None:
    _PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def _request_exit(signum, _frame):
    global _running
    _running = False
    _log(f"signal {signum} received; finishing current work then exiting")


signal.signal(signal.SIGTERM, _request_exit)
signal.signal(signal.SIGINT, _request_exit)


def _ensure_deps():
    """Import hermes STT machinery once; lazy-install faster-whisper like the
    old pipeline did if the import is missing."""
    global _tt, _get_read_block_error, _deps_failed_once
    if _tt is not None:
        return
    from faster_whisper import WhisperModel  # noqa: F401  (probe import)

    from tools.transcription_tools import (  # type: ignore
        DEFAULT_LOCAL_MODEL,
        DEFAULT_LOCAL_STT_LANGUAGE,
        LOCAL_NATIVE_AUDIO_FORMATS,
        _get_provider,
        _join_confident_segments,
        _load_stt_config,
        _normalize_local_model,
        _prepare_audio_for_transcription,
        _try_lazy_install_stt,
        _validate_audio_file,
        _validate_audio_source_file,
        build_local_transcribe_kwargs,
        is_stt_enabled,
        transcribe_audio,
    )

    class _TT:
        pass

    _tt = _TT()
    _tt.DEFAULT_LOCAL_MODEL = DEFAULT_LOCAL_MODEL
    _tt.DEFAULT_LOCAL_STT_LANGUAGE = DEFAULT_LOCAL_STT_LANGUAGE
    _tt.LOCAL_NATIVE_AUDIO_FORMATS = LOCAL_NATIVE_AUDIO_FORMATS
    _tt._get_provider = _get_provider
    _tt._join_confident_segments = _join_confident_segments
    _tt._load_stt_config = _load_stt_config
    _tt._normalize_local_model = _normalize_local_model
    _tt._prepare_audio_for_transcription = _prepare_audio_for_transcription
    _tt._try_lazy_install_stt = _try_lazy_install_stt
    _tt._validate_audio_file = _validate_audio_file
    _tt._validate_audio_source_file = _validate_audio_source_file
    _tt.build_local_transcribe_kwargs = build_local_transcribe_kwargs
    _tt.is_stt_enabled = is_stt_enabled
    _tt.transcribe_audio = transcribe_audio

    from agent.file_safety import get_read_block_error  # type: ignore
    _get_read_block_error = get_read_block_error


def _ensure_model():
    """Load the faster-whisper model once, pinned to CPU/int8 (this host has
    no usable CUDA; int8 is what hermes' auto path falls back to here)."""
    global _model, _model_name, _deps_failed_once
    _ensure_deps()
    if _model is not None and _model_name is not None:
        return _model
    try:
        model_name = _tt._normalize_local_model(MODEL_ARG)
    except Exception:
        model_name = MODEL_ARG
    if _deps_failed_once:
        # A previous dep failure may have been a missing faster-whisper; give
        # hermes' lazy installer one shot, exactly like the old pipeline.
        _deps_failed_once = False
        try:
            _tt._try_lazy_install_stt()
        except Exception as exc:
            _log(f"lazy-install attempt failed: {exc}")
    from faster_whisper import WhisperModel

    t0 = time.time()
    m = WhisperModel(model_name, device="cpu", compute_type="int8")
    _model = m
    _model_name = model_name
    _log(f"model '{model_name}' loaded on cpu/int8 in {time.time() - t0:.1f}s")
    return _model


def _process_transcribe(job: dict) -> dict:
    """Mirror transcribe_audio()'s local pipeline with a resident model."""
    _ensure_deps()
    path = str(job.get("path") or "")
    if not path:
        return {"success": False, "transcript": "", "error": "missing path"}

    blocked = _get_read_block_error(path)
    if blocked:
        return {"success": False, "transcript": "", "error": blocked}

    is_silk = path.lower().endswith(".silk")
    source_error = _tt._validate_audio_source_file(path, enforce_size_limit=is_silk)
    if source_error:
        return source_error

    prepared_path, cleanup_dir, prep_error = _tt._prepare_audio_for_transcription(path)
    if prep_error:
        return prep_error
    if prepared_path is None:
        return {
            "success": False,
            "transcript": "",
            "error": "Audio preprocessing did not produce a file for transcription.",
        }

    try:
        prepared_error = _tt._validate_audio_file(prepared_path, enforce_size_limit=False)
        if prepared_error:
            return prepared_error

        stt_config = _tt._load_stt_config()
        if not _tt.is_stt_enabled(stt_config):
            return {
                "success": False,
                "transcript": "",
                "error": "STT is disabled in config.yaml (stt.enabled: false).",
            }

        provider = _tt._get_provider(stt_config)
        if provider != "local":
            # Operator configured a different backend: delegate to the exact
            # pipeline the old inline code used (model stays loaded unused).
            _log(f"provider={provider!r} is not local; delegating to transcribe_audio")
            return _tt.transcribe_audio(path, model=(MODEL_ARG or None), source="gateway")

        local_cfg = stt_config.get("local") or {}
        model = _ensure_model()
        transcribe_kwargs = _tt.build_local_transcribe_kwargs(stt_config)
        segments, _info = model.transcribe(prepared_path, **transcribe_kwargs)
        transcript = _tt._join_confident_segments(segments, local_cfg)
        return {"success": True, "transcript": transcript, "provider": "local"}
    finally:
        if cleanup_dir:
            shutil.rmtree(cleanup_dir, ignore_errors=True)


def _handle(raw_line: str) -> None:
    try:
        job = json.loads(raw_line)
        if not isinstance(job, dict):
            raise ValueError("job must be a JSON object")
    except Exception as exc:
        _log(f"dropping malformed job line ({exc}): {raw_line[:200]!r}")
        return

    jid = str(job.get("id") or "")
    if not jid:
        _log(f"dropping job without id: {raw_line[:200]!r}")
        return

    op = str(job.get("op") or "transcribe")
    try:
        if op == "load":
            _ensure_model()
            emit({"id": jid, "ok": True})
        elif op == "ping":
            emit({"id": jid, "ok": True})
        elif op == "transcribe":
            t0 = time.time()
            res = _process_transcribe(job)
            _log(
                f"job {jid} {'ok' if res.get('success') else 'failed'} "
                f"in {time.time() - t0:.2f}s ({str(job.get('path') or '')[:120]})"
            )
            out = {"id": jid, "ok": bool(res.get("success")), "transcript": str(res.get("transcript") or "")}
            if res.get("error"):
                out["error"] = str(res["error"])
            out["provider"] = str(res.get("provider") or "local")
            emit(out)
        else:
            emit({"id": jid, "ok": False, "error": f"unknown op: {op}"})
    except Exception as exc:
        # Never die on a job error.
        _log(f"job {jid} raised: {type(exc).__name__}: {exc}")
        traceback.print_exc(file=sys.stderr)
        try:
            emit({"id": jid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        except BrokenPipeError:
            raise


def main() -> int:
    _log(f"pid={os.getpid()} model_arg={MODEL_ARG!r} python={sys.version.split()[0]}")
    global _deps_failed_once
    try:
        for raw in iter(sys.stdin.readline, ""):
            if not _running:
                break
            line = raw.strip()
            if not line:
                continue
            try:
                _handle(line)
            except BrokenPipeError:
                _log("stdout closed; exiting")
                return 0
            except Exception as exc:  # absolute last resort: stay alive
                _deps_failed_once = True
                _log(f"handler loop error (continuing): {type(exc).__name__}: {exc}")
        _log("stdin EOF; exiting cleanly")
        return 0
    except KeyboardInterrupt:
        _log("interrupted; exiting cleanly")
        return 0


if __name__ == "__main__":
    sys.exit(main())
