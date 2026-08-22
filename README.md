# jcode Telegram Bridge

![CI](https://github.com/iasds/jcode-telegram-bridge/actions/workflows/ci.yml/badge.svg)

A Telegram ↔ jcode bridge built on the official
[@1jehuang/jcode-sdk](https://jcode.sh/sdk). Messages from Telegram are
injected into a local jcode daemon session and replies stream back to
Telegram in real time.

Source: https://github.com/iasds/jcode-telegram-bridge

## Architecture

```
Telegram user ⇄ Bot API (native fetch long-poll, 15s poll)
    ⇅
bridge.ts: session mapping + command set + markdown rendering (hermes-agent port)
    ⇅ JcodeClient.connect() (unix socket)
jcode api-bridge ⇄ jcode daemon (shared live user session)
```

## Commands (aligned with the jcode TUI)

| Command | Purpose |
|---|---|
| /start /help | Welcome and help |
| /info | Session runtime info (provider / model) |
| /clear | Clear the current session history |
| /plan | Plan mode (plan only, no execution) |
| /model [name] | View / switch model |
| /compact | Request long-context compression |
| /cancel | Interrupt the current turn (verified: interrupts the daemon turn) |
| /status | Bridge and daemon status (bridge-only) |

## Voice STT (Hermes parity)

- **Pipeline**: `voice/audio/video_note (.ogg/.opus)` -> `getFile + fetch -> /tmp` -> `tools/transcription_tools parity` -> quoted `"transcript"` + `caption` injected as `enriched_text` (mirrors `gateway/run.py:_enrich_message_with_transcription`).
- **Defaults** (per local approval): `STT_LANGUAGE=zh` + `STT_LOCAL_MODEL=small` (`small` ~500MB, better zh WER than `base` on 2.2G box; `tiny`/`base`/`small`/`medium`/`large-v3` supported).
- **Provider order**: explicit `STT_PROVIDER` wins; auto `local (faster-whisper) > groq (whisper-large-v3-turbo) > openai (whisper-1)` with fallback to local on cloud failure (Hermes `_get_provider`).
- **Limits**: `25MB`, `SUPPORTED_FORMATS {.ogg/.opus/.mp3/.m4a/...}`; oversize/too-large echoes `[voice message too large]` and still delivers caption; `ffmpeg` transcodes `.ogg/.opus -> 16kHz mono 32k AAC m4a` for cloud endpoints.
- **Echo**: `STT_ECHO_TRANSCRIPTS=true` sends `🎙️ "transcript"` before the agent turn (Hermes `_echo_pending_stt_transcripts_once`).

## Deployment

```bash
npm install && npm run build && npm test
# configure
cp .env.example .env   # TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_ALLOWED_IDS
# systemd user services (both)
systemctl --user enable --now jcode-api-bridge.service jcode-tg-bridge.service
sudo loginctl enable-linger "$USER"   # auto-start on boot
```

## Design decisions

- **Streaming replies (per-turn child connection)**: the bridge consumes
  `events()` on a dedicated child connection per turn so replies stream into
  Telegram as progressive edits (throttled, with a ▉ cursor, tool segments,
  flood fallback). Falls back to `run()` only when the turn never started;
  a half-sent message is never re-run (double-execution guard).
- **Native fetch long-poll (not telegraf polling)**: telegraf 4.16's
  getUpdates request hardcodes a 500s timeout, and its abort only covers the
  request phase. When a transparent proxy sends response headers but stalls
  the body, `res.json()` hangs forever (poll dead, bridge deaf). We poll with
  native fetch + `AbortSignal.timeout(45s)` (covering the whole body read) +
  15s short poll + exponential backoff + exit after 5 consecutive failures
  for systemd to restart. See `getUpdatesRaw()`.
- **Duplicate-reply protection**: the poll offset is persisted to
  `poll-offset.txt` (derived from the `stateFile` directory). A restart never
  re-pulls already-delivered updates — this is what broke the "bot loops
  sending the same message" bug (restart loop + offset=0 + re-handling the
  same update). The idempotency logic lives in `src/logic.ts` and is unit
  tested.
- **Poisoned-session rotation**: attaching a session that is stuck
  server-side makes the daemon reset the socket. On connection close, or on
  any attach failure, the mapping for the last-attached session is dropped
  and recreated, so a restarted process gets a fresh session instead of
  looping forever.
- **Self-heal**: SDK connection loss (`disconnected`/`connect_failed`) or
  repeated poll failures exit with code 1; systemd `Restart=always` brings
  up a fresh process. `getMe` uses backoff (10 tries) so a transient proxy
  blip does not restart the bridge.
- **MarkdownV2 rendering ported from hermes-agent** (NousResearch/hermes-agent,
  open source): a 12-step pipeline (code-block protection, link conversion,
  tables to bullets, escaping, safety net), see `src/markdown.ts`, 14 unit
  tests.
- **Whitelist**: `TELEGRAM_BOT_ALLOWED_IDS` comma-separated; empty = allow all
- **Concurrency**: one fixed jcode session per chat (JSON persisted), messages
  on the same session are queued serially; turns run in the background
  (fire-and-forget) so commands like /cancel stay responsive
- **Full auto-approval**: the bridge has no permissions capability; tools run
  automatically (only reachable by whitelisted users)

## Testing

```bash
npm test   # node --test — 40 cases (markdown 14, stream 14, truncate, logic 12)
```

## Files

- `src/bridge.ts` entry / bot layer / native fetch poll / routing / self-heal
- `src/commands.ts` command set
- `src/logic.ts` pure reliability helpers (offset idempotency, rotation decision)
- `src/markdown.ts` MarkdownV2 rendering (hermes-agent port)
- `src/events.ts` rendering glue (working line, tool lines, final reply)
- `src/stream.ts` streaming reply renderer (progressive edits)
- `src/model-picker.ts` interactive /model selector
- `src/sessions.ts` chat→session mapping + concurrency queue + persistence
- `src/config.ts` environment configuration
- `test/*.test.mjs` unit tests
- `~/.config/systemd/user/jcode-{api-bridge,tg-bridge}.service` systemd units

## Operations / troubleshooting

- **Loop diagnosis**: a restart loop (repeated `fatal connection error`
  lines, growing `NRestarts`) usually means the daemon reset the socket
  because an attached session is poisoned. Check for `rotating session`
  warnings, then send any message to rebuild the session. The persisted
  `poll-offset.txt` guarantees a restart never re-sends old replies.
- **Stream stages**: `[stream] connect → connected → attach → attached →
  consuming events → turn_done (N events) → loop end → finished`. If it
  stops before `attached`, the session is likely broken (rotation kicks in).
- `/status` includes an STT health line (`STT worker: resident (fast) |
  down, inline fallback | idle`, with `deaths:N respawns:M` after crashes)
  and poll failures escalate: >=10 `getUpdates` errors within one hour log
  a `NETWORK HEALTH` warning once per hour (proxy-chain degradation signal).
- **STT**: each voice logs `[stt] voice ok|fail provider=… dur=…ms`. A
  resident Python worker (`src/stt_worker.py`) loads `faster-whisper
  small (zh)` once at boot (`[stt_worker] model 'small' loaded …` /
  `[stt] resident worker warm in ~3s`), so per-voice latency is warm-end
  (~3s) instead of a cold model load (~8s). If the worker dies it is
  respawned on demand; if respawn fails, transcription falls back to the
  in-process loader for that request. Concurrent voices are capped at 2.
  Failed transcripts still leave the durable `.jcode-media/telegram-voice/*.ogg`
  for the agent and log the anchor path. Pruning runs at boot (keep 7d / 500MB).
- **Silent bridge**: watch journald for `getUpdates error` (rate-limited:
  attempt 1, every 10th, and the fatal 5th are logged; a
  `recovered after N failed attempts (outage …)` summary marks recovery),
  `429` retries, and `NRestarts`
  (`systemctl --user show jcode-tg-bridge.service -p NRestarts`).
- **Config hardening**: `TURN_TIMEOUT_MS` (10s–30min) and `QUEUE_LIMIT` (1–20)
  are clamped; unknown `STT_LOCAL_MODEL` falls back to `small` with a warning.
- **Commands vs TUI**: /status and /info are bridge-only; all others align
  with the jcode TUI. Unknown commands are rejected, never sent to the agent.

## Known issues / roadmap

- The proxy (Clash) can still stall long-poll bodies; the 45s whole-read
  timeout mitigates it. If the bridge goes deaf, watch journald
  `getUpdates error` and `NRestarts`.
- Photos are not supported (no vision capability in the current model).
  Text documents ARE handled inline (text/* or known text extensions up to
  `MAX_INLINE_DOC_BYTES`, content injected as `[Content of <name>]:`); other
  files are announced as attachments. Voice/audio/video_note are fully
  supported via the STT pipeline above.
