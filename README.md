# jcode Telegram Bridge

![CI](https://github.com/iasds/jcode-telegram-bridge/actions/workflows/ci.yml/badge.svg)

A Telegram ↔ jcode bridge built on the official
[@1jehuang/jcode-sdk](https://jcode.sh/sdk). Messages from Telegram are
injected into a local jcode daemon session and replies stream back to
Telegram in real time.

Source: https://github.com/iasds/jcode-telegram-bridge

## Architecture

```
Telegram user ⇄ Bot API (native fetch long-poll, 5s poll)
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
- **Silent bridge**: watch journald for `getUpdates error`, `429` retries,
  and `NRestarts` (`systemctl --user show jcode-tg-bridge.service -p NRestarts`).
- **Commands vs TUI**: /status and /info are bridge-only; all others align
  with the jcode TUI. Unknown commands are rejected, never sent to the agent.

## Known issues / roadmap

- The proxy (Clash) can still stall long-poll bodies; the 45s whole-read
  timeout mitigates it. If the bridge goes deaf, watch journald
  `getUpdates error` and `NRestarts`.
- Media input (photos/documents) is deferred: the current model has no
  vision capability.
