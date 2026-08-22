import { test } from "node:test";
import assert from "node:assert/strict";
import { PollErrorLogger, FATAL_THRESHOLD } from "../dist/pollwatch.js";

const T0 = 1_000_000; // fixed epoch for deterministic outage durations

test("first failure logs a full line", () => {
  const l = new PollErrorLogger("getUpdates");
  const v = l.fail("fetch failed", T0);
  assert.equal(v.attempts, 1);
  assert.equal(v.shouldLog, true);
  assert.match(v.line, /getUpdates error: fetch failed$/);
});

test("attempts 2-4 are suppressed (no log)", () => {
  const l = new PollErrorLogger("getUpdates");
  l.fail("fetch failed", T0);
  for (let n = 2; n <= 4; n++) {
    const v = l.fail("timeout", T0 + n * 3_000);
    assert.equal(v.attempts, n);
    assert.equal(v.shouldLog, false);
  }
});

test("fatal threshold attempt always logs and reports its number", () => {
  const l = new PollErrorLogger("getUpdates");
  for (let n = 1; n < FATAL_THRESHOLD; n++) l.fail("x", T0);
  const v = l.fail("y", T0 + FATAL_THRESHOLD * 3_000);
  assert.equal(v.attempts, FATAL_THRESHOLD);
  assert.equal(v.shouldLog, true);
  assert.match(v.line, /attempt 5/);
  assert.match(v.line, /outage 15s/);
});

test("every 10th attempt logs even below the fatal threshold", () => {
  const l = new PollErrorLogger("getUpdates");
  let last;
  for (let n = 1; n <= 10; n++) last = l.fail("x", T0 + n * 60_000);
  assert.equal(last.attempts, 10);
  assert.equal(last.shouldLog, true);
  assert.match(last.line, /attempt 10, outage 9.0m/);
});

test("recovery after >=2 failures emits exactly one summary line", () => {
  const l = new PollErrorLogger("getUpdates");
  l.fail("a", T0);
  l.fail("b", T0 + 5_000);
  const r = l.recover(T0 + 9_000);
  assert.ok(r, "expected recovery verdict");
  assert.match(r.line, /recovered after 2 failed attempts \(outage 9s\)/);
  // counter reset: next failure is attempt 1 again
  const v = l.fail("c", T0 + 20_000);
  assert.equal(v.attempts, 1);
  assert.equal(v.shouldLog, true);
});

test("single-blip failure: recovery adds no summary line", () => {
  const l = new PollErrorLogger("getUpdates");
  l.fail("a", T0);
  assert.equal(l.recover(T0 + 1_000), null);
  assert.equal(l.recover(T0 + 2_000), null); // idempotent when healthy
});

test("duration formatting crosses minute and hour boundaries", () => {
  const l = new PollErrorLogger("getUpdates");
  l.fail("x", T0);
  const v90s = l.fail("x", T0 + 90_000);
  assert.match(v90s.line, /outage 1.5m/);
});
