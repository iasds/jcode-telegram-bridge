import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderKeyboard, buildModelKeyboard } from "../dist/model-picker.js";

function mkState(providers, modelList = []) {
  return {
    chatId: 1, msgId: 2, sessionId: "s",
    providers, selectedProvider: undefined,
    modelList, providerPage: 0, modelPage: 0,
  };
}

const manyProviders = Array.from({ length: 12 }, (_, i) => ({
  name: `prov${i}`, models: ["m1", "m2"], isCurrent: i === 0,
}));

// ── buildProviderKeyboard ─────────────────────────────────────────────────

const navOf = (rows) => rows.find(r => r.some(b => ["mpv","mg","mx:noop"].some(p => String(b.callback_data).startsWith(p))));

test("provider keyboard: single page has no nav row, cancel always present", () => {
  const s = mkState(manyProviders.slice(0, 3));
  const r = buildProviderKeyboard(s, 0);
  assert.equal(r.pageInfo, "");
  const rows = r.keyboard.inline_keyboard;
  assert.ok(!navOf(rows)); // no pagination row
  assert.deepEqual(rows[rows.length - 1], [{ text: "✗ Cancel", callback_data: "mx" }]);
});

test("provider keyboard: pagination slices correctly and nav rows appear", () => {
  const s = mkState(manyProviders); // 12 providers / page size 10 -> 2 pages
  const p0 = buildProviderKeyboard(s, 0);
  assert.equal(p0.pageInfo, " (1–10 of 12)");
  const rows0 = p0.keyboard.inline_keyboard;
  // first button of page 0 is current provider
  assert.match(rows0[0][0].text, /^✓ prov0/);
  assert.equal(rows0[0][0].callback_data, "mp:0");
  const nav0 = navOf(rows0);
  assert.deepEqual(nav0.map(b => b.text), ["1/2", "Next ▶"]); // no Prev on first page

  const p1 = buildProviderKeyboard(s, 99); // out-of-range clamps to last page
  assert.equal(p1.pageInfo, " (11–12 of 12)");
  const nav1 = navOf(p1.keyboard.inline_keyboard);
  assert.deepEqual(nav1.map(b => b.text), ["◀ Prev", "2/2"]);
});

test("provider keyboard: callback indices are absolute across pages", () => {
  const s = mkState(manyProviders);
  const p1 = buildProviderKeyboard(s, 1);
  const first = p1.keyboard.inline_keyboard[0][0];
  assert.equal(first.callback_data, "mp:10"); // global index, not per-page
});

// ── buildModelKeyboard ────────────────────────────────────────────────────

test("model keyboard: page slicing, back+cancel footer", () => {
  const models = Array.from({ length: 9 }, (_, i) => `model-${i}`);
  const s = mkState([], models);
  const p0 = buildModelKeyboard(s, 0);
  assert.equal(p0.pageInfo, " (1–8 of 9)");
  const rows = p0.keyboard.inline_keyboard;
  const footer = rows[rows.length - 1];
  assert.deepEqual(footer.map(b => b.callback_data), ["mb", "mx"]);
  // flat model buttons count = 8 on page 0
  const modelButtons = rows.flat().filter(b => String(b.callback_data).startsWith("mm:"));
  assert.equal(modelButtons.length, 8);
});

test("model keyboard: nav uses mg: prefix with absolute paging", () => {
  const models = Array.from({ length: 17 }, (_, i) => `m${i}`); // 3 pages
  const s = mkState([], models);
  const p1 = buildModelKeyboard(s, 1);
  const nav = p1.keyboard.inline_keyboard.find(r => r.some(b => b.callback_data?.startsWith("mg:")));
  assert.ok(nav);
  assert.deepEqual(nav.map(b => b.callback_data), ["mg:0", "mx:noop", "mg:2"]);
});
