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
