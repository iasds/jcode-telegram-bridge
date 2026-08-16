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
