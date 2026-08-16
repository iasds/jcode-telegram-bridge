import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingRenderer } from "../dist/stream.js";

function makeFakeBot() {
  const calls = [];
  let msgId = 100;
  let fail429 = false;
  let fail429Count = 0;
  return {
    telegram: {
      sendMessage: async (_chatId, text, _extra) => {
        calls.push({ type: "send", text });
        return { message_id: msgId++ };
      },
      editMessageText: async (_chatId, _mid, _a, text, extra) => {
        if (fail429 && fail429Count < 10) {
          fail429Count++;
          const e = new Error("429: Too Many Requests");
          e.response = { parameters: { retry_after: 1 } };
          throw e;
        }
        calls.push({ type: "edit", text, parse: extra?.parse_mode });
      },
    },
    calls,
    setFail429(v) {
      fail429 = v;
      fail429Count = 0;
    },
  };
}

test("start sends the cursor-only message", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  const id = await r.start();
  assert.equal(id, 100);
  assert.equal(bot.calls[0].type, "send");
  assert.ok(bot.calls[0].text.includes("▉"));
});

test("first delta flushes immediately (hermes behavior: elapsed large)", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("hello");
  assert.ok(bot.calls.filter((c) => c.type === "edit").length >= 1);
});

test("delta reaching 24 codepoints flushes with cursor", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("x".repeat(24));
  const edits = bot.calls.filter((c) => c.type === "edit");
  assert.equal(edits.length, 1);
  assert.ok(edits[0].text.endsWith("▉"), `cursor missing: ${edits[0].text}`);
  assert.ok(edits[0].text.startsWith("x".repeat(24)));
  assert.equal(edits[0].parse, undefined, "streaming edits are plain text");
});

test("streaming edits are plain text while streaming", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("y".repeat(30));
  const edits = bot.calls.filter((c) => c.type === "edit");
  assert.equal(edits[0].parse, undefined);
});

test("finish edits formatted text without cursor, MarkdownV2", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("**bold** text");
  await r.finish();
  const edits = bot.calls.filter((c) => c.type === "edit");
  const last = edits[edits.length - 1];
  assert.ok(!last.text.includes("▉"), "no cursor at finish");
  assert.equal(last.parse, "MarkdownV2");
  assert.ok(last.text.includes("*bold*"), "formatMessage applied");
});

test("3 flood strikes disable streaming (failed=true)", async () => {
  const bot = makeFakeBot();
  bot.setFail429(true);
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("x".repeat(30));
  await r.onDelta("y".repeat(30));
  assert.equal(r.failed, true, "flood should disable streaming");
});

test("tool start finalizes segment, sends tool line, starts fresh message", async () => {
  const bot = makeFakeBot();
  const r = new StreamingRenderer(bot, 1);
  await r.start();
  await r.onDelta("doing work");
  await r.onToolStart("bash");
  const edits = bot.calls.filter((c) => c.type === "edit");
  assert.ok(edits.length >= 1, "segment finalized");
  assert.ok(!edits[edits.length - 1].text.includes("▉"), "segment finalized without cursor");
  const sends = bot.calls.filter((c) => c.type === "send");
  assert.ok(sends.some((s) => s.text.includes("🔧")), "tool line sent");
  assert.ok(sends[sends.length - 1].text.includes("▉"), "fresh stream message started");
  assert.equal(r.accumulated, "", "accumulator reset after tool boundary");
});

test("finish: chunk 2+ MarkdownV2 rejection falls back to plain text", async () => {
  let markdownSends = 0;
  const calls = [];
  const bot = {
    telegram: {
      sendMessage: async (_chatId, text, extra) => {
        if (extra?.parse_mode) {
          markdownSends++;
          if (markdownSends === 1) {
            // First fresh chunk (chunks[1]) rejected -> plain fallback.
            const e = new Error("400: Bad Request");
            throw e;
          }
        }
        calls.push({ text, parse: extra?.parse_mode });
        return { message_id: 999 };
      },
      editMessageText: async () => true,
    },
  };
  const r = new StreamingRenderer(bot, 1);
  r.msgId = 100;
  r.accumulated = "y".repeat(9000); // >4096 -> chunked
  await r.finish();
  assert.ok(calls.some((c) => c.parse === undefined), "expected a plain-text fallback send");
});

test("finish: chunk 429 retries after Retry-After backoff", async () => {
  let attempts = 0;
  const calls = [];
  const bot = {
    telegram: {
      sendMessage: async (_chatId, text, extra) => {
        attempts++;
        if (attempts === 1) {
          const e = new Error("429: Too Many Requests");
          e.response = { parameters: { retry_after: 0 } };
          throw e;
        }
        calls.push(text);
        return { message_id: 999 };
      },
      editMessageText: async () => true,
    },
  };
  const r = new StreamingRenderer(bot, 1);
  r.msgId = 100;
  r.accumulated = "z".repeat(9000);
  await r.finish();
  assert.equal(attempts, 3, "2 chunks + 1 retry");
  assert.equal(calls.length, 2); // chunk1 retried + chunk2
});
