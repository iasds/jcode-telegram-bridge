import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIds, parseBool, clampInt } from "../dist/config.js";

// ── parseIds ───────────────────────────────────────────────────────────────

test("parseIds: empty/undefined -> []", () => {
  assert.deepEqual(parseIds(undefined), []);
  assert.deepEqual(parseIds(""), []);
  assert.deepEqual(parseIds("   "), []);
});

test("parseIds: splits on comma, trims, drops junk and non-positives", () => {
  assert.deepEqual(parseIds("1489280840"), [1489280840]);
  assert.deepEqual(parseIds(" 1 , 2 ,3 "), [1, 2, 3]);
  assert.deepEqual(parseIds("5,abc,-7,0,NaN"), [5]);
});

// ── parseBool ──────────────────────────────────────────────────────────────

test("parseBool: undefined/empty -> default", () => {
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool(undefined, false), false);
  assert.equal(parseBool("", false), false);
});

test("parseBool: truthy and falsey vocabularies, case-insensitive", () => {
  for (const v of ["1", "true", "ON", "Yes", "enable", "ENABLED"]) {
    assert.equal(parseBool(v, false), true, v);
  }
  for (const v of ["0", "false", "off", "No", "disable", "DISABLED"]) {
    assert.equal(parseBool(v, true), false, v);
  }
});

test("parseBool: unknown value -> default (not an error)", () => {
  assert.equal(parseBool("maybe", true), true);
  assert.equal(parseBool("maybe", false), false);
});

// ── clampInt ───────────────────────────────────────────────────────────────

test("clampInt: undefined/empty -> default", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    assert.equal(clampInt(undefined, 600_000, 10_000, 1_800_000, "T"), 600_000);
    assert.equal(clampInt("", 5, 1, 20, "Q"), 5);
    assert.equal(warns.length, 0);
  } finally { console.warn = orig; }
});

test("clampInt: invalid values warn and fall back to default", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    assert.equal(clampInt("abc", 600_000, 10_000, 1_800_000, "TURN_TIMEOUT_MS"), 600_000);
    assert.equal(clampInt("-5", 5, 1, 20, "QUEUE_LIMIT"), 5); // non-positive -> default
    assert.equal(warns.length, 2);
    assert.match(warns[0], /invalid TURN_TIMEOUT_MS="abc"/);
  } finally { console.warn = orig; }
});

test("clampInt: out-of-range clamps with warning; truncates floats", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    assert.equal(clampInt("5", 10, 1, 20, "Q"), 5); // in range untouched
    assert.equal(clampInt("999", 10, 1, 20, "Q"), 20);
    assert.equal(clampInt("0.5", 10, 1, 20, "Q"), 1);
    assert.ok(warns.some(w => /Q=999 clamped to 20/.test(w)));
  } finally { console.warn = orig; }
});
