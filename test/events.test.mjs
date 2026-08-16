import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnRenderer } from "../dist/events.js";

function makeCtx(overrides = {}) {
  const calls = { send: [], edit: [] };
  const ctx = {
    chat: { id: 1 },
    telegram: {
      sendMessage: async (chatId, text, extra) => {
        calls.send.push({ chatId, text, extra });
        return { message_id: 42 };
      },
      editMessageText: async (chatId, msgId, _a, text, extra) => {
        calls.edit.push({ chatId, msgId, text, extra });
        return true;
      },
      ...overrides,
    },
  };
  return { ctx, calls };
}

test("sendWorking: returns message_id and includes reply_parameters", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  const id = await r.sendWorking(1, 99);
  assert.equal(id, 42);
  assert.equal(calls.send[0].text, "⏳ Working…");
  assert.deepEqual(calls.send[0].extra.reply_parameters, { message_id: 99 });
});

test("sendWorking: no cached ctx -> undefined, no calls", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  const id = await r.sendWorking(1, undefined);
  assert.equal(id, undefined);
  assert.equal(calls.send.length, 0);
  assert.equal(calls.edit.length, 0);
});

test("sendToolLine: sends the 🔧 line", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  await r.sendToolLine(1, "bash");
  assert.equal(calls.send[0].text, "🔧 [bash]");
});

test("finishWith: short reply edits the working message once, no extra sends", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  await r.finishWith(1, 7, "hello world");
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].msgId, 7);
  assert.equal(calls.edit[0].text, "hello world");
  assert.equal(calls.send.length, 0);
});

test("finishWith: long reply chunks (>4096) edit once then send the rest", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  const long = "x".repeat(9000);
  await r.finishWith(1, 7, long);
  assert.equal(calls.edit.length, 1); // chunk 0 replaces working line
  assert.ok(calls.send.length >= 1); // chunks 1+ sent fresh
  const sent = calls.send.map((c) => c.text).join("");
  assert.ok(sent.includes("x"));
  assert.ok(calls.send.every((c) => c.extra.parse_mode === "MarkdownV2"));
});

test("finishWith: MarkdownV2 rejected (400) falls back to plain text", async () => {
  let first = true;
  const { ctx, calls } = makeCtx({
    editMessageText: async (chatId, msgId, _a, text, extra) => {
      if (first && extra?.parse_mode) {
        first = false;
        const e = new Error("400: Bad Request: can't parse entities");
        throw e;
      }
      calls.edit.push({ chatId, msgId, text, extra });
      return true;
    },
  });
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  await r.finishWith(1, 7, "*bold* and [link](https://x.com/a_(b))");
  // Fallback: plain edit (no parse_mode) then plain sends.
  const plainEdit = calls.edit.find((c) => !c.extra?.parse_mode);
  assert.ok(plainEdit, "expected a plain-text edit");
  assert.ok(calls.send.every((c) => !c.extra?.parse_mode));
});

test("safeSendMessage: 429 retries with Retry-After backoff", async () => {
  let attempts = 0;
  const { ctx, calls } = makeCtx({
    sendMessage: async (chatId, text, extra) => {
      attempts++;
      if (attempts === 1) {
        const e = new Error("429: Too Many Requests");
        e.response = { parameters: { retry_after: 0 } };
        throw e;
      }
      calls.send.push({ chatId, text, extra });
      return { message_id: 42 };
    },
  });
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  await r.safeSendMessage(1, "retry me");
  assert.equal(attempts, 2, "should retry once after 429");
  assert.equal(calls.send.length, 1);
});

test("safeSendMessage: no cached ctx is a silent no-op", async () => {
  const { ctx, calls } = makeCtx();
  const r = new TurnRenderer();
  await r.safeSendMessage(1, "hello");
  assert.equal(calls.send.length, 0);
});

test("safeSendMessage: markdown fallback to plain on 400", async () => {
  let first = true;
  const { ctx, calls } = makeCtx({
    sendMessage: async (chatId, text, extra) => {
      if (first && extra?.parse_mode) {
        first = false;
        const e = new Error("400: Bad Request");
        throw e;
      }
      calls.send.push({ chatId, text, extra });
      return { message_id: 42 };
    },
  });
  const r = new TurnRenderer();
  r.cacheContext(1, ctx);
  await r.safeSendMessage(1, "*bold* text");
  // One rejected markdown attempt, then plain sends.
  assert.ok(calls.send.every((c) => !c.extra?.parse_mode));
  assert.ok(calls.send.length >= 1);
});
