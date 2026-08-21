import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../dist/fsutil.js";

test("writeFileAtomic: content correct after write, no .tmp residue", () => {
  const dir = mkdtempSync(join(tmpdir(), "jcode-fsutil-test-"));
  try {
    const target = join(dir, "state.json");
    writeFileAtomic(target, JSON.stringify({ chats: { "42": { sessionId: "s1" } } }, null, 2));
    assert.equal(
      readFileSync(target, "utf8"),
      JSON.stringify({ chats: { "42": { sessionId: "s1" } } }, null, 2),
    );
    // Atomicity contract: tmp file renamed away, nothing left behind in the dir.
    assert.deepEqual(readdirSync(dir), ["state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic: overwrites existing content atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "jcode-fsutil-test-"));
  try {
    const target = join(dir, "poll-offset.txt");
    writeFileSync(target, "906275210", { mode: 0o600 });
    writeFileAtomic(target, "906275211");
    assert.equal(readFileSync(target, "utf8"), "906275211");
    assert.deepEqual(readdirSync(dir), ["poll-offset.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
