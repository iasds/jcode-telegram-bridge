import { test } from "node:test";
import assert from "node:assert/strict";
import { TextBatchAggregator, isLikelyTextChunk } from "../dist/batch.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic fake scheduler: collects callbacks, returns a no-op cancel. */
function fakeSchedule(collect) {
  return (fn) => {
    collect.push(fn);
    return () => {};
  };
}

test("same chat: multiple pushes merge into a single flush joined with newline", () => {
  const calls = [];
  const scheduled = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { schedule: fakeSchedule(scheduled) },
  );
  assert.equal(agg.pendingCount(), 0);

  agg.push(7, "part one");
  agg.push(7, "part two");
  agg.push(7, "part three");
  assert.equal(agg.pendingCount(), 1);
  // Each push reschedules the timer; the pending callback is the latest one.
  assert.equal(scheduled.length, 3);

  scheduled[2](); // fire the timer
  assert.deepEqual(calls, [
    { chatId: 7, text: "part one\npart two\npart three" },
  ]);
  assert.equal(agg.pendingCount(), 0);
});

test("different chats are independent: flush(chatId) is targeted", () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }));
  agg.push(1, "hello");
  agg.push(2, "world");
  assert.equal(agg.pendingCount(), 2);

  agg.flush(1);
  assert.deepEqual(calls, [{ chatId: 1, text: "hello" }]);
  assert.equal(agg.pendingCount(), 1);

  agg.flush();
  assert.deepEqual(calls, [
    { chatId: 1, text: "hello" },
    { chatId: 2, text: "world" },
  ]);
  assert.equal(agg.pendingCount(), 0);
});

test("maxWaitMs: quiet period elapses and auto-flushes", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 30,
  });
  agg.push(5, "single message");
  assert.equal(agg.pendingCount(), 1);

  await sleep(90);
  assert.deepEqual(calls, [{ chatId: 5, text: "single message" }]);
  assert.equal(agg.pendingCount(), 0);
});

test("maxWaitMs: a later push resets the timer (no premature flush)", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 60,
  });
  agg.push(5, "first");
  await sleep(40); // inside the quiet window
  agg.push(5, "second");
  await sleep(30); // still inside the window reset by the second push
  assert.equal(calls.length, 0, "must not flush before the reset window elapses");

  await sleep(80); // now past maxWaitMs after the second push
  assert.deepEqual(calls, [{ chatId: 5, text: "first\nsecond" }]);
  assert.equal(agg.pendingCount(), 0);
});

test("flush(chatId) cancels that chat's pending timer (no later auto-flush)", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 30,
  });
  agg.push(1, "doomed");
  agg.flush(1);
  assert.deepEqual(calls, [{ chatId: 1, text: "doomed" }]);

  await sleep(80);
  assert.equal(calls.length, 1, "no duplicate flush after manual flush");
});

test("destroy: cancels timers and drops buffers, no flush afterward", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 30,
  });
  agg.push(1, "never");
  agg.push(2, "never either");
  agg.destroy();
  assert.equal(agg.pendingCount(), 0);

  await sleep(80);
  assert.equal(calls.length, 0);
});

test("flush on empty aggregator or unknown chat is a safe no-op", () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }));
  agg.flush();
  agg.flush(99);
  agg.push(1, "x");
  agg.flush(42); // unknown chat: no-op, chat 1 stays pending
  assert.equal(calls.length, 0);
  assert.equal(agg.pendingCount(), 1);
  agg.flush(1);
  assert.deepEqual(calls, [{ chatId: 1, text: "x" }]);
});

test("push after flush starts a fresh batch", () => {
  const calls = [];
  const scheduled = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { schedule: fakeSchedule(scheduled) },
  );
  agg.push(3, "a");
  scheduled[0]();
  assert.deepEqual(calls, [{ chatId: 3, text: "a" }]);

  agg.push(3, "b");
  scheduled[1]();
  assert.deepEqual(calls, [
    { chatId: 3, text: "a" },
    { chatId: 3, text: "b" },
  ]);
});

test("custom join option controls the concatenation separator", () => {
  const calls = [];
  const scheduled = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { join: "|", schedule: fakeSchedule(scheduled) },
  );
  agg.push(9, "a");
  agg.push(9, "b");
  scheduled[1]();
  assert.deepEqual(calls, [{ chatId: 9, text: "a|b" }]);
});

test("single-part flush preserves the original text verbatim", () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }));
  agg.push(4, "no trailing newline");
  agg.flush(4);
  assert.deepEqual(calls, [{ chatId: 4, text: "no trailing newline" }]);
});

test("isLikelyTextChunk: default 4000 threshold", () => {
  const prev = "x".repeat(4000);
  assert.equal(isLikelyTextChunk(prev, "continuation"), true);
  assert.equal(isLikelyTextChunk("x".repeat(3999), "continuation"), false);
  assert.equal(isLikelyTextChunk("", "anything"), false);
});

test("isLikelyTextChunk: custom threshold", () => {
  assert.equal(isLikelyTextChunk("x".repeat(100), "y", 100), true);
  assert.equal(isLikelyTextChunk("x".repeat(99), "y", 100), false);
  assert.equal(isLikelyTextChunk("x".repeat(10), "y", 0), true, "threshold 0 means every previous message qualifies");
});

// ── ST-03: pushNow immediate flush ─────────────────────────────────────────

test("pushNow: flushes synchronously, no quiet-period wait, other chats unaffected", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 30,
  });
  // A text burst is already buffered for chat 2 (quiet timer pending).
  agg.push(2, "burst part");
  assert.equal(agg.pendingCount(), 1);

  agg.pushNow(7, "voice transcript");
  assert.deepEqual(calls, [{ chatId: 7, text: "voice transcript" }],
    "pushNow must invoke the flush callback synchronously (before any timer)");
  assert.equal(agg.pendingCount(), 1, "chat 2's pending buffer must be untouched");

  await sleep(80);
  assert.deepEqual(calls, [
    { chatId: 7, text: "voice transcript" },
    { chatId: 2, text: "burst part" },
  ], "chat 2 still flushes via its own quiet timer; chat 7 must NOT flush again");
});

test("pushNow: coalesces with an in-flight buffer and cancels its timer", () => {
  const scheduled = [];
  const calls = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { schedule: fakeSchedule(scheduled) },
  );
  agg.push(5, "earlier text"); // arms a quiet timer
  agg.pushNow(5, "urgent voice note");
  // Both parts go out together, ordering preserved, single synchronous flush.
  assert.deepEqual(calls, [{ chatId: 5, text: "earlier text\nurgent voice note" }]);
  assert.equal(agg.pendingCount(), 0);
  // Firing every armed (now stale) timer must not produce a duplicate
  // delivery: the flush removed the buffer and cancelled its timers.
  for (const fn of scheduled) fn();
  assert.equal(calls.length, 1, "no duplicate flush from stale timers after pushNow");
});

// ── P-03-lite: hardCapMs starvation guard ──────────────────────────────────

/** Manual-clock scheduler harness for deterministic timer tests. */
function makeClockScheduler(nowFn) {
  const timers = [];
  let seq = 0;
  return {
    timers,
    schedule(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: nowFn() + ms, fn, cancelled: false });
      return () => {
        const t = timers.find((x) => x.id === id);
        if (t) t.cancelled = true;
      };
    },
    fireDue() {
      const due = timers.filter((t) => !t.cancelled && t.at <= nowFn());
      for (const t of due) {
        t.cancelled = true;
        t.fn();
      }
      return due.length;
    },
  };
}

test("hardCapMs: quiet-reset starvation still flushes at the hard cap", () => {
  let clock = 0;
  const sched = makeClockScheduler(() => clock);
  const calls = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { maxWaitMs: 50, hardCapMs: 120, schedule: sched.schedule, now: () => clock },
  );

  agg.push(1, "m1"); // quiet timer @50, hard-cap timer @120
  clock = 40;
  agg.push(1, "m2"); // resets quiet window (@90); cap untouched
  assert.equal(sched.fireDue(), 0, "nothing due at t=40");
  clock = 80;
  agg.push(1, "m3"); // resets quiet window again (@130) — classic starvation
  assert.equal(sched.fireDue(), 0, "quiet flush must stay suppressed by resets");

  clock = 120; // total buffer age reaches hardCapMs
  const fired = sched.fireDue();
  assert.equal(fired, 1, "exactly the hard-cap timer fires");
  assert.deepEqual(calls, [{ chatId: 1, text: "m1\nm2\nm3" }]);
  assert.equal(agg.pendingCount(), 0);

  clock = 500;
  sched.fireDue(); // stale quiet timer was cancelled by the flush
  assert.equal(calls.length, 1, "no duplicate flush afterwards");
});

test("hardCapMs: unset (default) preserves quiet-period-only behavior", () => {
  let clock = 0;
  const sched = makeClockScheduler(() => clock);
  const calls = [];
  const agg = new TextBatchAggregator(
    (chatId, text) => calls.push({ chatId, text }),
    { maxWaitMs: 50, schedule: sched.schedule }, // no hardCapMs
  );

  // Burst of resets while timers keep being cancelled before firing...
  clock = 0; agg.push(1, "m0");
  clock = 40; agg.push(1, "m40"); assert.equal(sched.fireDue(), 0);
  clock = 80; agg.push(1, "m80"); assert.equal(sched.fireDue(), 0);
  clock = 120; agg.push(1, "m120"); assert.equal(sched.fireDue(), 0);
  // ...then the burst STOPS. No cap timer exists, so nothing fires until
  // the final quiet window (t=170) elapses.
  clock = 100; assert.equal(sched.fireDue(), 0);
  clock = 169; assert.equal(sched.fireDue(), 0);
  clock = 170; assert.equal(sched.fireDue(), 1);
  assert.deepEqual(calls, [{ chatId: 1, text: "m0\nm40\nm80\nm120" }]);
});

test("hardCapMs: real-timer smoke test — starving burst flushes by the cap", async () => {
  const calls = [];
  const agg = new TextBatchAggregator((chatId, text) => calls.push({ chatId, text }), {
    maxWaitMs: 25,
    hardCapMs: 60,
  });
  agg.push(3, "a");
  await new Promise((r) => setTimeout(r, 15));
  agg.push(3, "b"); // reset #1
  await new Promise((r) => setTimeout(r, 15));
  agg.push(3, "c"); // reset #2 — past this point age > 60ms soon
  await new Promise((r) => setTimeout(r, 45));
  assert.deepEqual(calls, [{ chatId: 3, text: "a\nb\nc" }], "hard cap flushed the starved buffer");
  assert.equal(agg.pendingCount(), 0);
});

// ── Orphaned hard-cap timer regression (owl review finding) ────────────────

test("hardCapMs: cap timer is cancelled when the buffer flushes early", () => {
  let clock = 0;
  const sched = makeClockScheduler(() => clock);
  const calls = [];
  const agg = new TextBatchAggregator((id, text) => calls.push({ id, text }), {
    maxWaitMs: 50,
    hardCapMs: 120,
    schedule: sched.schedule,
    now: () => clock,
  });
  agg.push(1, "m1"); // arms quiet @50 and cap @120
  clock = 50;
  sched.fireDue(); // quiet flush; buffer gone
  clock = 120;
  assert.equal(sched.fireDue(), 0, "cap timer must not survive its own buffer's flush");
  assert.equal(calls.length, 1);
});

test("hardCapMs: stale cap timer from an old burst must not flush a new buffer early", () => {
  let clock = 0;
  const sched = makeClockScheduler(() => clock);
  const calls = [];
  const agg = new TextBatchAggregator((id, text) => calls.push({ id, text }), {
    maxWaitMs: 50,
    hardCapMs: 120,
    schedule: sched.schedule,
    now: () => clock,
  });
  agg.push(1, "burst-one"); // quiet @50, cap @120
  clock = 50;
  sched.fireDue(); // flushes burst-one via quiet timer
  assert.equal(calls.length, 1);
  clock = 110;
  agg.push(1, "burst-two-a"); // new generation: quiet @160, fresh cap @230
  clock = 120; // OLD cap deadline reached
  assert.equal(sched.fireDue(), 0, "stale cap timer must be cancelled on flush");
  clock = 160; // new generation's quiet timer
  assert.equal(sched.fireDue(), 1, "only the new generation's quiet timer fires");
  assert.deepEqual(calls, [
    { id: 1, text: "burst-one" },
    { id: 1, text: "burst-two-a" },
  ]);
});

test("destroy() cancels hard-cap timers too", () => {
  let clock = 0;
  const sched = makeClockScheduler(() => clock);
  const calls = [];
  const agg = new TextBatchAggregator((id, text) => calls.push({ id, text }), {
    maxWaitMs: 50,
    hardCapMs: 120,
    schedule: sched.schedule,
    now: () => clock,
  });
  agg.push(1, "m1");
  agg.destroy();
  clock = 120;
  assert.equal(sched.fireDue(), 0, "cap timer must not fire after destroy()");
  assert.equal(calls.length, 0);
});
