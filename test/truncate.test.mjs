import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateMessage, MAX_MESSAGE_LENGTH } from "../dist/truncate.js";

test("short message stays single chunk", () => {
  assert.deepEqual(truncateMessage("hello"), ["hello"]);
});

test("long plain message splits with (i/N) indicators, each chunk <= 4096", () => {
  const text = "word ".repeat(3000); // 15000 chars
  const chunks = truncateMessage(text);
  assert.ok(chunks.length > 1, "should split");
  assert.match(chunks[0], / \(1\/\d+\)$/);
  assert.match(chunks[chunks.length - 1], / \(\d+\/\d+\)$/);
  for (const c of chunks) {
    assert.ok(c.length <= MAX_MESSAGE_LENGTH, `chunk too long: ${c.length}`);
  }
  // Reassembled content preserved (minus indicators)
  const joined = chunks.map((c) => c.replace(/\s*\(\d+\/\d+\)$/, "")).join("");
  assert.ok(joined.startsWith("word "));
  assert.ok(joined.trimEnd().endsWith("word"));
});

test("fenced code block across chunks is closed and reopened with language", () => {
  const line = "x".repeat(500);
  const body = `Here is some text.\n\n\`\`\`python\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n\`\`\`\n\nthe end`;
  assert.ok(body.length > MAX_MESSAGE_LENGTH);
  const chunks = truncateMessage(body);
  assert.ok(chunks.length > 1);
  // First chunk must close any opened fence
  if (chunks[0].includes("```python")) {
    const fenceCount = (chunks[0].match(/```/g) ?? []).length;
    assert.equal(fenceCount % 2, 0, "fences must be balanced in each chunk");
  }
  // A chunk that continues the block reopens with python
  const reopened = chunks.find((c) => c.includes("```python\n"));
  assert.ok(reopened, "should reopen python fence");
  // Every chunk has balanced fences
  for (const c of chunks) {
    const clean = c.replace(/\s*\(\d+\/\d+\)$/, "");
    assert.equal((clean.match(/```/g) ?? []).length % 2, 0, `unbalanced fences: ${clean.slice(0, 60)}`);
  }
});

test("inline code span is not split", () => {
  const text = "before `code_with_underscores_and_long_text_".padEnd(200, "a") + "` after " + "y".repeat(5000);
  const chunks = truncateMessage(text);
  // Find the chunk containing the inline code; backticks must be paired
  for (const c of chunks) {
    const clean = c.replace(/\s*\(\d+\/\d+\)$/, "");
    const bt = (clean.match(/`/g) ?? []).length;
    assert.equal(bt % 2, 0, `inline backticks unpaired: ${clean.slice(0, 80)}`);
  }
});

test("UTF-16 surrogate pairs (emoji/Chinese) stay intact at boundary", () => {
  const text = "😀".repeat(3000); // 6000 UTF-16 units
  const chunks = truncateMessage(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const clean = c.replace(/\s*\(\d+\/\d+\)$/, "");
    assert.ok(!clean.includes("\uFFFD"), "no replacement chars");
    assert.ok(clean.length % 2 === 0, "surrogate pairs intact");
  }
});

test("final chunk inside an unclosed fence gets FENCE_CLOSE appended", () => {
  const line = "x".repeat(500);
  const body = `intro\n\`\`\`python\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\nmore code`;
  // No closing fence anywhere: the whole tail stays inside the block.
  assert.ok(body.length > MAX_MESSAGE_LENGTH);
  assert.ok(!body.includes("\n```\n"), "fixture has no closing fence");
  const chunks = truncateMessage(body);
  assert.ok(chunks.length > 1);
  const last = chunks[chunks.length - 1].replace(/\s*\(\d+\/\d+\)$/, "");
  assert.ok(last.endsWith("```"), `last chunk should end with closing fence: ${JSON.stringify(last.slice(-30))}`);
  assert.equal((last.match(/```/g) ?? []).length % 2, 0, "final chunk fences must be balanced");
});

test("already-closed fence in final chunk is not double-closed", () => {
  const line = "x".repeat(500);
  // The closing fence is the very last line of the content, so it lands in
  // the final chunk; the walk sees it and must not append FENCE_CLOSE again.
  const body = `intro\n\`\`\`python\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n\`\`\``;
  assert.ok(body.length > MAX_MESSAGE_LENGTH);
  const chunks = truncateMessage(body);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const clean = c.replace(/\s*\(\d+\/\d+\)$/, "");
    assert.equal((clean.match(/```/g) ?? []).length % 2, 0, `unbalanced fences: ${clean.slice(0, 60)}`);
  }
  const last = chunks[chunks.length - 1].replace(/\s*\(\d+\/\d+\)$/, "");
  assert.ok(last.endsWith("```"), "final chunk should still carry its closing fence");
  assert.ok(!last.endsWith("\n```\n```"), `double-closed fence: ${JSON.stringify(last.slice(-30))}`);
});

test("leading whitespace at a split boundary is stripped (lstrip)", () => {
  const text = "x".repeat(4000) + "\n  继续" + "y".repeat(1000);
  assert.ok(text.length > MAX_MESSAGE_LENGTH);
  const chunks = truncateMessage(text);
  assert.ok(chunks.length > 1, "should split");
  const second = chunks[1].replace(/\s*\(\d+\/\d+\)$/, "");
  assert.ok(!/^\s/.test(second), `second chunk starts with whitespace: ${JSON.stringify(second.slice(0, 12))}`);
  assert.ok(second.startsWith("继续"), "content after stripped whitespace is preserved");
});
