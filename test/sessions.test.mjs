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

test("getOrCreateSafe: concurrent calls on unmapped chat create exactly ONE session", async () => {
  let createCalls = 0;
  const countingClient = {
    createSession: async () => {
      createCalls++;
      // Simulate daemon latency so concurrent callers overlap.
      await new Promise((r) => setTimeout(r, 10));
      return { session_id: `session_${createCalls}` };
    },
  };
  const store = new SessionStore(countingClient, cfg);

  // Fire N concurrent Safe lookups on an unmapped chat, like two rapid commands.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.getOrCreateSafe(42)),
  );

  assert.equal(createCalls, 1, "daemon createSession must be called exactly once");
  const ids = new Set(results.map((st) => st.sessionId));
  assert.equal(ids.size, 1, "all callers must observe the same session");
});

test("getOrCreateSafe: serializes with route()'s queue work on the same chat", async () => {
  let createCalls = 0;
  const countingClient = {
    createSession: async () => {
      createCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return { session_id: `session_${createCalls}` };
    },
  };
  const store = new SessionStore(countingClient, cfg);

  // Seed a stale mapping so the test can distinguish serialized from
  // non-serialized execution: a broken (non-queued) Safe lookup would
  // observe the seeded mapping and return "session_stale" with 0 creates,
  // while a correctly serialized one waits behind the turn's removal and
  // must create fresh.
  store.set(7, {
    sessionId: "session_stale",
    mode: "normal",
    workdir: cfg.workDir,
    createdAt: Date.now(),
  });

  // Interleave a long queue turn (route()-style) with a Safe lookup.
  const turn = store.enqueue(7, async () => {
    await new Promise((r) => setTimeout(r, 20));
    store.remove(7); // rotate-style removal mid-turn
  });
  const safe = store.getOrCreateSafe(7).then((st) => st.sessionId);
  const [, sessionId] = await Promise.all([turn, safe]);
  // The Safe lookup ran strictly after the turn removed the mapping,
  // so it created a fresh session instead of observing the stale one.
  assert.equal(createCalls, 1);
  assert.match(sessionId, /^session_1$/);
});
