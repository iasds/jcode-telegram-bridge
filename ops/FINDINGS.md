# Findings Ledger — 3h Optimization (2026-08-21)

Merged + deduped from 6 auditors: cow(stability/journal), crocodile(concurrency), cricket(STT latency),
dog(startup/throughput), dove(input security), eagle(supply chain). Wave-1 assignments below.

## Wave 1 — HIGH stability + push-blocker (fix first)

| ID | Sev | Src | Location | Issue | Fix | Est |
|---|---|---|---|---|---|---|
| S-00 | HIGH | crocodile F-00 | bridge.ts:868-876 | offset saved BEFORE handleUpdate batch → crash drops unprocessed updates (silent message loss) | move saveOffset after Promise.all resolves | ~8L |
| S-01 | HIGH | crocodile F-01 | sessions.ts:51-65, commands.ts | getOrCreate/createSession runs outside per-chat queue → duplicate daemon sessions / mid-turn repoint on concurrent commands | wrap getOrCreate in store.enqueue | ~10L |
| S-02 | HIGH | crocodile F-02 | bridge.ts:168-182,557-580 | poisoned-session close races in-flight turns; user silence up to 10min then timeout | bounded grace before fatalExit when activeTurns>0; mark rotated chats so siblings reuse recreated session | ~12L |
| SEC-01 | HIGH | dove FG-01 | bridge.ts:285 | callback_query handler lacks allowed() check — any group member can press picker buttons → client.setModel | gate callback_query with allowed() | ~3L |
| SEC-02 | MED | dove FG-03 | bridge.ts:295-297 | cacheContext/lastCtx.set BEFORE auth gate → unbounded pre-auth map growth by arbitrary users | move cache writes after auth check | ~5L |

## Wave 2 — atomicity + boot

| ID | Sev | Src | Location | Issue | Fix | Est |
|---|---|---|---|---|---|---|
| S-03 | MED | crocodile F-03/F-04 | sessions.ts:138, bridge.ts:220,801 | non-atomic writes state.json/home.json/poll-offset.txt; torn offset=0 replays ALL updates (duplicate storm); torn state.json = context amnesia. Probed parseOffset accepts truncated digits | shared atomic write helper (tmp+rename+fsync) | ~20L |
| P-01 | MED | dog F1 | bridge.ts:134 | top-level await connectWithRetry blocks bot setup 0–30s (deaf at boot) | promise-gate the client; register handlers+poll immediately | ~25L |
| P-02 | LOW | dog F2 | bridge.ts:744 | sync pruneVoiceDurables pre-poll (0.2–2s @28K files) | defer 30s post-first-poll + hourly interval | ~6L |
| ST-01 | MED | cricket F3 | bridge.ts:100-109 | warmupStt never verifies "warmup ok" (53ms journal entries = instant python exit suspicion) | verify stdout marker + exit code, fail loudly | ~8L |
| ST-02 | LOW | cricket F5 | bridge.ts:426-442 | double sync buffer write + dynamic imports in hot path | static imports, single durable write + copyFile | ~10L |

## Wave 3 — latency + throughput

| ID | Sev | Src | Location | Issue | Fix | Est |
|---|---|---|---|---|---|---|
| ST-03 | MED | cricket F2 | batch.ts, bridge.ts mediaDeliver | voice transcript waits full 800ms quiet window for nothing | immediate flush for single-part transcript buffers | ~15L |
| P-03 | MED | dog F3 | batch.ts:94-100 | every text msg eats flat 800ms; burst starvation (timer resets, no span cap) | leading-edge flush + hard cap 2500ms | ~10L |
| P-04 | LOW | dog F4 | stream.ts:147 | O(n²) codepoint spread per delta | incremental counter | ~4L |
| P-05 | LOW | dog F5 | markdown.ts:189 | O(n·p²) placeholder restore split/join per placeholder | single-pass regex restore | ~5L |
| P-06 | LOW | dog F6 | truncate.ts:121 | O(n²) remaining.slice per chunk | index-window slicing | ~15L |
| ST-04 | LOW | cricket F6 | bridge.ts:557-594 | getOrCreate+attach strictly after STT; zero input dependency | prefetch in parallel with download/STT | ~15L |
| M-01 | LOW | dog F7/F8 | events.ts:32, bridge.ts:196-198, sessions.ts:93 | unbounded Maps (ctxCache/lastCtx/lastUserTexts/queue tails) | LRU cap or delete-on-clear | ~17L |

## Backlog — RESOLVED 2026-08-21 (Caesar approved "按你的来")

| ID | Item | Outcome |
|---|---|---|
| B-01 | Resident python STT worker | DONE commit 58c4500. stt_worker.py JSON-lines daemon, model resident; warm transcribe 7.7s → 3.0–3.5s (−55%); self-heal respawn + inline fallback kept |
| B-02 | In-process harness reconnect | WON'T DO (deliberate): saves only ~3–5s vs systemd restart; adds reconnect state machine + double-connection risk on top of P-01 gate. S-02 grace already protects in-flight turns. Revisit only if restarts become frequent |
| B-03 | Local blob purge + token rotation | Purge DONE (reflog expire + gc --prune=now; 33eda3e unreachable, reachable history verified clean). Token rotation at BotFather remains a 2-min manual step for Caesar — recommended |
| B-04 | /status etc. during connect window | NO CHANGE NEEDED: /status and /info already wrap client calls in try/catch with friendly "daemon connection failed" replies |

## Clean bills (no action)
- Path traversal via file_name (dove), command injection (all arg-array spawn), TOCTOU ALLOWED_IDS,
  decompression bombs, queue flood clamp
- npm audit 0 vulns incl dev, lockfile consistent, no world-writables, no token logging
- git history (reachable) secret-free across 7609 lines
- Journal 24h: 48× fetch-fail + 5× timeout = transient network, retry already bounds them (cow)

## Post-freeze ops notes
- eagle F-01: run `git reflog expire --expire=now --all && git gc --prune=now` AFTER final push; rotate token via BotFather separately.
