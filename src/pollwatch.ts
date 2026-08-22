// Rate-limited error logging for long-running retry loops (pollLoop).
//
// Problem being solved: transient network outages made pollLoop emit up to 5
// near-identical "getUpdates error" lines per outage, burying real defects in
// the journal. Policy now: log attempt 1 fully, stay silent for attempts
// 2-9/11-19..., log every 10th attempt with a running outage duration, and
// always log the fatal-threshold attempt. On recovery after >=2 failures,
// emit exactly one summary line so operators can see outage length at a
// glance. Single-blip failures log their own line and no summary (no noise
// added vs. removed).
//
// Pure logic, no I/O: callers pass `now` and print the returned lines, which
// keeps the policy unit-testable without spying on console.

export interface FailVerdict {
  /** Total consecutive failures including this one. */
  attempts: number;
  /** Fully formatted line, identical whether logged here or at fatal exit. */
  line: string;
  /** Whether the caller should print this line. */
  shouldLog: boolean;
}

export interface RecoverVerdict {
  line: string;
}

export const FATAL_THRESHOLD = 5;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export class PollErrorLogger {
  private failures = 0;
  private firstFailAt = 0;
  /** Sliding-window failure tally for hourly health escalation (P2). */
  private recentFailures: number[] = [];
  /** Last hour-boundary at which an hourly summary was emitted. */

  constructor(private readonly label: string) {}

  /**
   * P2: failures in the trailing `windowMs`. When this crosses
   * `escalateAt`, the caller should WARN that the network path itself may be
   * degraded (proxy chain, DNS) rather than treating each blip as transient.
   */
  failuresInWindow(now: number, windowMs = 3_600_000): number {
    this.recentFailures = this.recentFailures.filter((t) => now - t < windowMs);
    return this.recentFailures.length;
  }

  get attempts(): number {
    return this.failures;
  }

  /** Record one failure; returns what (if anything) to log. */
  fail(msg: string, now: number): FailVerdict {
    this.failures++;
    this.recentFailures.push(now);
    if (this.failures === 1) this.firstFailAt = now;
    const dur = formatDuration(Math.max(0, now - this.firstFailAt));
    const line =
      this.failures === 1
        ? `[bridge] ${this.label} error: ${msg}`
        : `[bridge] ${this.label} still failing (attempt ${this.failures}, outage ${dur}): ${msg}`;
    const shouldLog =
      this.failures === 1 ||
      this.failures % 10 === 0 ||
      this.failures >= FATAL_THRESHOLD;
    return { attempts: this.failures, line, shouldLog };
  }

  /**
   * Record a success after failures. Returns a recovery summary line when
   * >=2 consecutive failures elapsed, else null (single blips were already
   * logged individually; adding a summary would be pure noise).
   */
  recover(now: number): RecoverVerdict | null {
    if (this.failures === 0) return null;
    const n = this.failures;
    const dur = formatDuration(Math.max(0, now - this.firstFailAt));
    this.failures = 0;
    if (n === 1) return null;
    return {
      line: `[bridge] ${this.label} recovered after ${n} failed attempts (outage ${dur})`,
    };
  }
}
