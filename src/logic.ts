/**
 * Pure decision/parsing helpers extracted from bridge.ts so the core
 * reliability logic (poll-offset idempotency, session rotation, stream
 * fallback) is unit-testable. No I/O, no telegraf, no SDK imports.
 */

/** Harness errors with these codes mean the whole connection is dead. */
export const FATAL_CODES = new Set(["disconnected", "connect_failed"]);

/**
 * Advance the poll offset past the highest update_id in a batch.
 * An empty batch must NOT move the offset (returning 0 would re-pull
 * every unconfirmed update after a crash and re-send the same replies —
 * the "bot loops sending the same message" bug).
 */
export function advanceOffset(updates: { update_id: number }[], currentOffset: number): number {
  if (updates.length === 0) return currentOffset;
  return updates.reduce((max, u) => Math.max(max, u.update_id), currentOffset) + 1;
}

/**
 * Parse a persisted poll offset. Anything non-finite, missing, or <= 0 is
 * treated as 0 (start from the beginning) — but callers should always pass
 * a previously loaded offset so a corrupt file can't silently re-pull.
 */
export function parseOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True when the harness connection itself is dead (no point rotating a session). */
export function isFatalHarnessError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && FATAL_CODES.has(code);
  }
  return false;
}

/**
 * After a stream failure, run() once is only safe if the turn never started
 * on the daemon; otherwise it would execute the turn twice and double-reply.
 */
export function canFallbackToRun(turnStarted: boolean): boolean {
  return !turnStarted;
}
