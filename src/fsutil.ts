import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

/**
 * Atomic + durable file write (S-03/S-04).
 *
 * Writes to a per-process temp file in the SAME directory as the target (so
 * the rename stays on one filesystem and concurrent writers never collide on
 * a shared tmp name), fsyncs the payload, then renames over the target. A
 * crash mid-write leaves either the old or the new file intact — never torn.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const fd = openSync(tmp, "w", mode);
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
