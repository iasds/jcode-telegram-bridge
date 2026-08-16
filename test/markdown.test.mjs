import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage, stripMdv2, escapeMdv2 } from "../dist/markdown.js";

test("bold and italic conversion", () => {
  assert.equal(formatMessage("**粗体** 和 *斜体*"), "*粗体* 和 _斜体_");
});

test("plain underscores stay escaped, not converted", () => {
  const out = formatMessage("变量 a_b 和下划线");
  assert.ok(out.includes("a\\_b"), `expected escaped underscore, got: ${out}`);
});

test("inline code protected verbatim", () => {
  assert.equal(formatMessage("`code_here` 和 `a-b_c`"), "`code_here` 和 `a-b_c`");
});

test("fenced code block protected with backslash and backtick escaping", () => {
  const input = "```js\nconst x = 1; // a-b_c\n```";
  const out = formatMessage(input);
  assert.equal(out, "```js\nconst x = 1; // a-b_c\n```");
  // backslash inside code must be doubled per MarkdownV2 spec
  const out2 = formatMessage("```\nC:\\\\path\n```");
  assert.ok(out2.includes("C:\\\\\\\\path"), `backslash should be doubled: ${out2}`);
});

test("link display escaped, url parens escaped", () => {
  const out = formatMessage("[链接](https://example.com/a_(b))");
  assert.equal(out, "[链接](https://example.com/a_\\(b\\))");
});

test("headers become bold", () => {
  assert.equal(formatMessage("## 标题"), "*标题*");
});

test("pipe table becomes bullet groups", () => {
  const input = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
  const out = formatMessage(input);
  assert.ok(out.includes("*1*"), `missing bold heading: ${out}`);
  assert.ok(out.includes("• B: 2"), `missing bullet: ${out}`);
  assert.ok(out.includes("*3*"), `missing second heading: ${out}`);
});

test("tables inside code fences untouched", () => {
  const input = "```\n| A | B |\n|---|---|\n```";
  assert.equal(formatMessage(input), input);
});

test("bullet list dash escaped", () => {
  assert.equal(formatMessage("- item1\n- item2"), "\\- item1\n\\- item2");
});

test("strikethrough and spoiler", () => {
  assert.equal(formatMessage("~~删除~~ ||剧透||"), "~删除~ ||剧透||");
});

test("blockquote preserved", () => {
  assert.equal(formatMessage("> 引用块"), "> 引用块");
});

test("plain hyphen/underscore in identifiers escaped", () => {
  const out = formatMessage("deepseek-v4-flash");
  assert.equal(out, "deepseek\\-v4\\-flash");
});

test("stripMdv2 round-trip removes escapes and markers", () => {
  // Input is pipeline output (MarkdownV2), not raw markdown.
  const raw = "*粗体* _斜体_ ~删~ ||spoiler|| \\- dash \\_ under";
  assert.equal(stripMdv2(raw), "粗体 斜体 删 spoiler - dash _ under");
});

test("escapeMdv2 escapes full special set", () => {
  assert.equal(escapeMdv2("_*[]()~`>#+-=|{}.!\\"), "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
});

test("pipe table with row-label column renders heading + bullets", () => {
  const input = "| 项目 | 状态 |\n|---|---|\n| 桥 | ✅ |\n| 队列 | ✅ |";
  const out = formatMessage(input);
  assert.ok(out.includes("*桥*"), `missing row heading: ${out}`);
  assert.ok(out.includes("• 状态: ✅"), `missing bullet: ${out}`);
});

test("nested parens in link URL survive", () => {
  const out = formatMessage("[a](https://x.com/p/(1)/q)");
  assert.equal(out, "[a](https://x.com/p/\\(1\\)/q)");
});
