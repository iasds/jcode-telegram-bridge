# Final Report — 3h High-Intensity Optimization (2026-08-21)

Run window: T0 11:43:30Z → T+2:15 13:58Z (wrapped early, all waves + stress complete).
Coordination: root session (ox-alpha-free) + 12 spawned sub-agents (6 auditors, 4 fixers, 2 reviewers), token-unlimited.

## Before / After

| Metric | Baseline (T0) | Final | Delta |
|---|---|---|---|
| Test suite | 83/83, 2786ms | **97/97**, 2925ms | +14 tests, time flat |
| tsc build | 1119ms | 559ms | −50% |
| STT warmup verification | silent-fail (53ms = python crash, `av` module missing since day one) | verified PASS, warmup 4050ms real | **real bug found+fixed** |
| Voice transcription (10s oga) | broken on this host (No module 'av') | PASS 7.7–8.7s, transcript correct | fixed via pip av install |
| Boot-to-polling | blocked 0–30s by connectWithRetry | immediate (promise gate) | P-01 |
| Poll offset crash window | save-before-handle → silent message loss | at-least-once after batch | S-00 HIGH |
| Concurrent commands on new chat | duplicate daemon sessions leak | serialized getOrCreateSafe | S-01 HIGH |
| Harness close during active turn | 10min silence then timeout | 5s grace, fast-fail paths run | S-02 HIGH |
| Picker buttons in groups | any member could setModel | allowed() gated | SEC-01 HIGH |
| Pre-auth cache growth | unbounded per arbitrary user | gated + capped(64) | SEC-02/M-01 |
| state.json/offset writes | non-atomic, torn offset=0 replay storm risk | tmp+fsync+rename atomic | S-03/S-04 |
| Batch latency floor | flat 800ms every message | voice/doc instant flush; text hardCap 10s anti-starvation | ST-03/P-03 |
| Hot-path complexity | O(n²) stream/truncate/markdown | incremental/single-pass/window-slice | P-04/05/06 |
| Fire-and-forget rejections | unhandledRejection possible (proved empirically) | routeCatchLog on all 3 sites | fuzz finding |
| Secrets/proxy hygiene | stt.ts comment leaked proxy topology; charter line too | scrubbed (1501541) | push-blocker cleared |

## Live deployment
Both units restarted on final build 9f285d8: dual-active, NRestarts=0, polling started,
warmup small done 4050ms, kill -9 recovery verified (auto-restart, polling resumed),
voice end-to-end PASS.

## Commits (origin/master..HEAD)
0081813 charter+baseline · 1501541 proxy scrub · 4f21aa4 findings ledger · 07d7ff4 gitignore ·
7064f82 wave-1 · 4308426 wave-2 · 62d036c wave-3 · 9f285d8 route-rejection catch

## Backlog (needs Caesar, NOT pushed as code changes)
- B-01: resident python STT worker (−1.2–3s/request, ~30% total voice latency cut, ~100 LOC)
- B-02: in-process harness reconnect instead of process.exit (current systemd path works)
- B-03: rotate bot token at BotFather — unreachable local-only blobs (tgmin.mjs/tgcombo.mjs, commit 33eda3e) contain a live-token-format string, never pushed. Post-push: `git reflog expire --expire=now --all && git gc --prune=now`
- B-04 (ops): `/status` etc. touch client ungated during the 15s connect window → "harness connecting" reply only on turn path; cosmetic.

## Environment fix applied outside repo
`pip install --user --break-system-packages av` — faster_whisper's decode_audio dependency
was missing entirely; STT had never actually worked on this VM despite earlier test passing
(that test ran on a different python env resolution).
