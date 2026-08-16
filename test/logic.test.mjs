import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceOffset,
  parseOffset,
  isFatalHarnessError,
  canFallbackToRun,
  FATAL_CODES,
} from "../dist/logic.js";

test("advanceOffset: empty batch keeps current offset (idempotency guard)", () => {
  assert.equal(advanceOffset([], 42), 42);
  assert.equal(advanceOffset([], 0), 0);
});

test("advanceOffset: single update -> id + 1", () => {
  assert.equal(advanceOffset([{ update_id: 5 }], 0), 6);
  assert.equal(advanceOffset([{ update_id: 100 }], 99), 101);
});

test("advanceOffset: batch -> max id + 1 regardless of order", () => {
  const batch = [{ update_id: 3 }, { update_id: 9 }, { update_id: 4 }];
  assert.equal(advanceOffset(batch, 2), 10);
  const shuffled = [{ update_id: 9 }, { update_id: 4 }, { update_id: 3 }];
  assert.equal(advanceOffset(shuffled, 8), 10);
});

test("advanceOffset: never goes backwards", () => {
  // Stale batch (already seen ids) must still move forward from current.
  assert.equal(advanceOffset([{ update_id: 5 }], 50), 51);
});

test("parseOffset: empty/undefined -> 0", () => {
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset(""), 0);
});

test("parseOffset: garbage -> 0", () => {
  assert.equal(parseOffset("abc"), 0);
  assert.equal(parseOffset("12abc"), 0);
  assert.equal(parseOffset("   "), 0);
});

test("parseOffset: non-positive -> 0", () => {
  assert.equal(parseOffset("0"), 0);
  assert.equal(parseOffset("-5"), 0);
});

test("parseOffset: positive integer with whitespace -> number", () => {
  assert.equal(parseOffset(" 906275161\n"), 906275161);
});

test("isFatalHarnessError: fatal codes are fatal", () => {
  for (const code of FATAL_CODES) {
    assert.equal(isFatalHarnessError({ code }), true, `code ${code}`);
  }
});

test("isFatalHarnessError: session-level errors are NOT fatal (rotate instead)", () => {
  assert.equal(isFatalHarnessError({ code: "unknown_session" }), false);
  assert.equal(isFatalHarnessError({ code: "session_poisoned" }), false);
});

test("isFatalHarnessError: plain errors / null / undefined are not fatal", () => {
  assert.equal(isFatalHarnessError(new Error("boom")), false);
  assert.equal(isFatalHarnessError("string error"), false);
  assert.equal(isFatalHarnessError(null), false);
  assert.equal(isFatalHarnessError(undefined), false);
});

test("canFallbackToRun: only safe when turn never started", () => {
  assert.equal(canFallbackToRun(false), true);
  assert.equal(canFallbackToRun(true), false);
});
