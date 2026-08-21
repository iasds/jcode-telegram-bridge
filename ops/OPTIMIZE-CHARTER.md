# Optimize Charter — 3h High-Intensity Pass (2026-08-21)

Coordinator: root session (ox-alpha). Workers inherit same model. Token budget: unlimited.
Deadline arithmetic (UTC): T0=2026-08-21T11:43:30Z → fix-freeze T+2:20=14:03:30Z → final report+push by T+3:00=14:43:30Z.

## Objectives (priority order on conflict)
1. Stability — no crashes, bounded retries, clean recovery from kill/restart, zero unhandled rejections
2. Security — input validation, path traversal, permissions, log leaks, DoS surface
3. Speed — STT latency, fetch timeouts, batching windows, startup sequence

## Rules of engagement
- Workers edit ONLY their assigned file set per wave (mutex enforced by coordinator).
- Any change >100 lines diff or new dependency → FINDINGS.md backlog, needs Caesar approval.
- Every worker self-verifies (tsc + targeted tests) before reporting; coordinator runs the full gate:
  `npm run build` (0 err) → `npm test` (83+/83+) → secrets/proxy grep gate → service restart health.
- Red gate = send back to same worker for rework, unlimited rounds.
- Green gate = coordinator commits serially: `optimize(<lane>): <summary>`.
- Cross review: one idle agent adversarially reviews each batch before commit; objections → rework.
- RED LINES: never touch `.env`, never commit tokens/secrets/proxy node names (日本JP-HY2/mihomo etc),
  no push until final unified push at T+2:50.
- Live services must stay up: test against dist build only after unit tests; restarts allowed (bot reconnects).

## Baseline snapshot (T0) — see BASELINE.md
tsc 1119ms · tests 2786ms 83/83 · dual units active · journal 24h: 55 err/fail/timeout lines (AUDIT TARGET #1)
· stt warmup 53ms hot / ~3500ms cold · durables 28K · npm audit 0 vulns · mem 1191/2701M
