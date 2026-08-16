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
  assert.ok(sends.some((s) => s.text.includes("💻 [bash]")), "tool line sent with mapped emoji");
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

// ── B1: 429 flood doubles the edit interval ────────────────────────────────

test("B1: 429 flood doubles the edit interval, capped at 10s (fake now)", async () => {
  let nowMs = 0;
  let editCalls = 0;
  const flushes = [];
  const bot = {
    telegram: {
      sendMessage: async () => ({ message_id: 100 }),
      editMessageText: async () => {
        editCalls++;
        if (editCalls % 2 === 1) {
          // Fail the first attempt of every edit() call with a 429.
          const e = new Error("429: Too Many Requests");
          e.response = { parameters: { retry_after: 0 } };
          throw e;
        }
        flushes.push(nowMs);
        return true;
      },
    },
  };
  const r = new StreamingRenderer(bot, 1, undefined, () => nowMs);
  await r.start();

  nowMs = 100_000; // huge elapsed -> immediate flush -> 429
  await r.onDelta("a");
  assert.equal(r.editIntervalMs, 1600, "interval doubled after first 429");
  assert.equal(flushes.length, 1, "first flush happened");

  nowMs = 101_000; // 1000ms < 1600ms doubled interval -> still throttled
  await r.onDelta("b");
  assert.equal(flushes.length, 1, "no flush while under the doubled interval");

  nowMs = 101_600; // 1600ms elapsed -> flush -> second 429
  await r.onDelta("c");
  assert.equal(r.editIntervalMs, 3200, "interval doubles again after second 429");
  assert.equal(flushes.length, 2, "flush once doubled interval elapsed");

  nowMs = 101_600 + 3200; // >= 3200ms -> flush -> third 429 disables streaming
  await r.onDelta("d");
  assert.ok(r.editIntervalMs <= 10_000, `interval stays within 10s cap (${r.editIntervalMs})`);
  assert.equal(r.failed, true, "third 429 disables streaming");
});

// ── B2: disableLinkPreviews on chunk sends ─────────────────────────────────

test("B2: disableLinkPreviews adds link_preview_options to chunk sends, not edits", async () => {
  const sends = [];
  const edits = [];
  const bot = {
    telegram: {
      sendMessage: async (_c, _t, extra) => {
        sends.push(extra);
        return { message_id: 999 };
      },
      editMessageText: async (_c, _m, _a, _t, extra) => {
        edits.push(extra);
        return true;
      },
    },
  };
  const r = new StreamingRenderer(bot, 1, undefined, Date.now, { disableLinkPreviews: true });
  r.msgId = 100;
  r.accumulated = "y".repeat(9000); // >4096 -> chunked
  await r.finish();
  assert.ok(sends.length >= 2, "expected 2+ chunk sends");
  for (const extra of sends) {
    assert.deepEqual(extra.link_preview_options, { is_disabled: true }, "chunk send disables previews");
  }
  for (const extra of edits) {
    assert.equal(extra.link_preview_options, undefined, "edit path has no link preview control");
  }
});

test("B2: without opts, chunk sends carry no link_preview_options (backward compat)", async () => {
  const sends = [];
  const bot = {
    telegram: {
      sendMessage: async (_c, _t, extra) => {
        sends.push(extra);
        return { message_id: 999 };
      },
      editMessageText: async () => true,
    },
  };
  const r = new StreamingRenderer(bot, 1); // no opts
  r.msgId = 100;
  r.accumulated = "z".repeat(9000);
  await r.finish();
  assert.ok(sends.length >= 2, "expected 2+ chunk sends");
  for (const extra of sends) {
    assert.equal(extra.link_preview_options, undefined, "no preview control by default");
  }
});

// ── B3: tool emoji mapping ─────────────────────────────────────────────────

test("B3: tool line uses mapped emoji for known tool names", async () => {
  const sends = [];
  const bot = {
    telegram: {
      sendMessage: async (_c, text) => {
        sends.push(text);
        return { message_id: 999 };
      },
      editMessageText: async () => true,
    },
  };
  const r = new StreamingRenderer(bot, 1);
  await r.onToolStart("bash");
  assert.equal(sends[0], "💻 [bash]", "bash maps to 💻 in the tool line");
});

test("B3: known tool names map to emojis, unknown falls back to ⚙️", async () => {
  const cases = [
    ["bash", "💻"],
    ["shell", "💻"],
    ["python", "🐍"],
    ["node", "🟩"],
    ["read", "📄"],
    ["write", "📄"],
    ["grep", "🔍"],
    ["search", "🔍"],
    ["web_search", "🌐"], // substring match
    ["http_request", "🌐"], // substring match
    ["git_diff", "🔀"], // substring match
    ["no_such_tool", "⚙️"],
    ["Bash", "💻"], // case-insensitive
  ];
  for (const [name, emoji] of cases) {
    const lines = [];
    const bot = {
      telegram: {
        sendMessage: async (_c, text) => {
          lines.push(text);
          return { message_id: 999 };
        },
        editMessageText: async () => true,
      },
    };
    const r = new StreamingRenderer(bot, 1);
    await r.onToolStart(name);
    assert.ok(
      lines[0]?.startsWith(`${emoji} [`),
      `${name} should render as ${emoji} [...], got: ${lines[0]}`,
    );
  }
});
