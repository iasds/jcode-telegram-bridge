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

test("writeFileAtomic: default mode is 0600 for a fresh file (secrets-safe)", async (t) => {
  const { statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "jcode-fsutil-test-"));
  try {
    const target = join(dir, "token.txt");
    writeFileAtomic(target, "secret");
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic: rename REPLACES target inode, so mode comes from the new tmp file", async (t) => {
  // Documented semantics (not a bug): rename() swaps the whole inode, so an
  // existing file's looser/equal mode does NOT survive; callers relying on
  // non-default modes must pass `mode` explicitly. Lock this in so a future
  // refactor cannot silently change it.
  const { chmodSync, statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "jcode-fsutil-test-"));
  try {
    const target = join(dir, "state.json");
    writeFileSync(target, "old", { mode: 0o644 });
    writeFileAtomic(target, "new"); // no explicit mode -> fresh inode at 0600
    assert.equal(statSync(target).mode & 0o777, 0o600,
      "rename-over must yield a fresh 0600 inode, not inherit the old mode");
    void chmodSync;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
