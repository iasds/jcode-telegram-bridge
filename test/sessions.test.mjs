import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, QueueFullError } from "../dist/sessions.js";

const tmp = mkdtempSync(join(tmpdir(), "jcode-sessions-test-"));
const cfg = {
  stateFile: join(tmp, "state.json"),
};

const fakeClient = {
  createSession: async () => ({ session_id: `session_${Math.random()}` }),
};

function makeStore() {
  return new SessionStore(fakeClient, cfg);
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("enqueue: runs queued tasks serially", async () => {
  const store = makeStore();
  const order = [];
  const p1 = store.enqueue(1, async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push(1);
  });
  const p2 = store.enqueue(1, async () => {
    order.push(2);
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

test("enqueue: respects limit and rejects with QueueFullError", async () => {
  const store = makeStore();
  // One turn occupies the queue for 50ms.
  const running = store.enqueue(
    1,
    async () => new Promise((r) => setTimeout(r, 50)),
  );
  // Fill remaining slots up to the limit (5 total, 4 more).
  const pending = [];
  for (let i = 0; i < 4; i++) {
    pending.push(store.enqueue(1, async () => {}, 5));
  }
  // The 6th enqueue must be rejected immediately.
  await assert.rejects(
    store.enqueue(1, async () => {}, 5),
    (err) => err instanceof QueueFullError && err.limit === 5,
  );
  await Promise.all([running, ...pending]);
});

test("queueDepth: tracks running + pending, returns to 0", async () => {
  const store = makeStore();
  assert.equal(store.queueDepth(1), 0);
  const running = store.enqueue(1, async () => new Promise((r) => setTimeout(r, 30)));
  assert.equal(store.queueDepth(1), 1);
  const p2 = store.enqueue(1, async () => {}, 5);
  assert.equal(store.queueDepth(1), 2);
  await Promise.all([running, p2]);
  assert.equal(store.queueDepth(1), 0);
});

test("allQueueDepths: only reports non-idle chats", async () => {
  const store = makeStore();
  assert.deepEqual(store.allQueueDepths(), []);
  const p1 = store.enqueue(7, async () => new Promise((r) => setTimeout(r, 30)));
  store.enqueue(7, async () => {}, 5);
  store.enqueue(9, async () => new Promise((r) => setTimeout(r, 10)));
  const depths = store.allQueueDepths();
  assert.deepEqual(depths, [
    [7, 2],
    [9, 1],
  ]);
  await p1;
  // After completion, chat 9 finishes first; chat 7 still has one pending.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.queueDepth(7), 0);
  assert.equal(store.queueDepth(9), 0);
});

test("enqueue: previous failure does not block the next task", async () => {
  const store = makeStore();
  const failing = store.enqueue(1, async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);
  // Next task still runs.
  let ran = false;
  await store.enqueue(1, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
