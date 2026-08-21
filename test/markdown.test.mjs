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

// ── P-05: single-pass placeholder restore ─────────────────────────────────

test("P-05: interleaved placeholders restore exactly (header/bold/code/link/strike)", () => {
  const out = formatMessage(
    "## 标题\n**粗体** 和 `代码` 以及 [链接](https://e.com/a_(b)) 和 ~~删除~~",
  );
  assert.equal(
    out,
    "*标题*\n*粗体* 和 `代码` 以及 [链接](https://e.com/a_\\(b\\)) 和 ~删除~",
  );
});

test("P-05: nested placeholder inside a placeholder value resolves depth-first", () => {
  // `code` becomes PH0 first; the bold span then becomes PH1 whose VALUE
  // contains the PH0 token. Restore must recurse: PH1 -> *a PH0 b* -> *a `code` b*.
  const out = formatMessage("**a `code` b**");
  assert.equal(out, "*a `code` b*");
});

test("P-05: multiple distinct indices inside one value all resolve", () => {
  const out = formatMessage("**x `c1` y `c2` z**");
  assert.equal(out, "*x `c1` y `c2` z*");
});

test("P-05: foreign placeholder-looking tokens are left verbatim (no crash)", () => {
  const input = "before\u0000PH999\u0000after";
  assert.equal(formatMessage(input), input);
});

test("P-05: many protected spans over a large document stay verbatim and fast", () => {
  const parts = [];
  for (let i = 0; i < 400; i++) parts.push(`para ${i} with \`code_${i}\` and **b${i}**`);
  const input = parts.join("\n\n");
  const t0 = process.hrtime.bigint();
  const out = formatMessage(input);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `formatMessage took ${ms}ms`);
  for (let i = 0; i < 400; i += 97) {
    assert.ok(out.includes(`\`code_${i}\``), `span ${i} missing`);
    assert.ok(out.includes(`*b${i}*`), `bold ${i} missing`);
  }
  assert.ok(!out.includes("\u0000"), "no placeholder leaked into output");
});
