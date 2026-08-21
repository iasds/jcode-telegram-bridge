/**
 * Long-message chunking, ported from hermes-agent's BasePlatformAdapter.
 * truncate_message (gateway/platforms/base.py).
 *
 * Splits at natural boundaries (newline, then space), never inside inline
 * code spans, closes and reopens fenced code blocks across chunks, and
 * appends (i/N) indicators when a message spans multiple chunks.
 *
 * JS string .length is UTF-16 code units, which is exactly Telegram's
 * message-length unit, so no separate len_fn is needed.
 */

export const MAX_MESSAGE_LENGTH = 4096;
const INDICATOR_RESERVE = 10; // room for " (XX/XX)"
const FENCE_CLOSE = "\n```";

/** Map a UTF-16 budget to the largest UTF-16 slice offset on a codepoint boundary. */
function customUnitToCp(s: string, budget: number): number {
  let used = 0;
  for (const ch of s) {
    const u = ch.length; // 1 or 2 UTF-16 units (surrogate pair)
    if (used + u > budget) break;
    used += u;
  }
  return used;
}

export function truncateMessage(content: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  // Index window into `content` (P-06: the old loop reassigned
  // remaining = remaining.slice(splitAt), copying the rest of a potentially
  // multi-hundred-KB string on every chunk, O(n²). We keep ONE reference to
  // the original string and only ever slice small windows out of it.
  let pos = 0; // absolute start offset of the not-yet-chunked text
  let leadTrim = 0; // leading whitespace already stripped after last split
  let carryLang: string | null = null;

  while (pos < content.length) {
    // One-chunk working copy; O(maxLength), not O(remaining).
    const remaining = content.slice(pos + leadTrim);
    const base = pos + leadTrim; // absolute offset of remaining[0]
    leadTrim = 0;

    // Reopen a code block carried from the previous chunk.
    const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : "";

    let headroom = maxLength - INDICATOR_RESERVE - prefix.length - FENCE_CLOSE.length;
    if (headroom < 1) headroom = Math.max(1, Math.floor(maxLength / 2));

    // Everything remaining fits in one final chunk.
    if (prefix.length + remaining.length <= maxLength - INDICATOR_RESERVE) {
      let finalChunk = prefix + remaining;
      // If the previous chunk ended inside a fenced code block (carryLang
      // set), this chunk starts with a reopening fence. Walk the remaining
      // text to see whether the block was closed; if it is still open,
      // append FENCE_CLOSE so the final chunk stands alone. When the text
      // already ends with a closing fence (its last line is "```"), the
      // walk ends with the block closed and nothing extra is appended.
      if (carryLang !== null) {
        let finalInCode = true;
        for (const line of remaining.split("\n")) {
          const stripped = line.trim();
          if (stripped.startsWith("```")) {
            finalInCode = !finalInCode;
          }
        }
        if (finalInCode) {
          finalChunk += FENCE_CLOSE;
        }
      }
      chunks.push(finalChunk);
      break;
    }

    const cpLimit = customUnitToCp(remaining, headroom);
    const region = remaining.slice(0, cpLimit);
    let splitAt = region.lastIndexOf("\n");
    if (splitAt < Math.floor(cpLimit / 2)) splitAt = region.lastIndexOf(" ");
    if (splitAt < 1) splitAt = Math.max(1, cpLimit);

    // Avoid splitting inside an inline code span (odd unescaped backticks).
    const candidate = remaining.slice(0, splitAt);
    const backticks = (candidate.match(/`/g) ?? []).length;
    const escapedBackticks = (candidate.match(/\\`/g) ?? []).length;
    if ((backticks - escapedBackticks) % 2 === 1) {
      let lastBt = candidate.lastIndexOf("`");
      while (lastBt > 0 && candidate[lastBt - 1] === "\\") {
        lastBt = candidate.lastIndexOf("`", lastBt - 1);
      }
      if (lastBt > 0) {
        const safeSplit = Math.max(
          candidate.lastIndexOf(" ", lastBt),
          candidate.lastIndexOf("\n", lastBt),
        );
        if (safeSplit > Math.floor(cpLimit / 4)) splitAt = safeSplit;
      }
    }

    const chunkBody = remaining.slice(0, splitAt);
    let fullChunk = prefix + chunkBody;

    // Determine whether the chunk ends inside an open fenced code block.
    let inCode = carryLang !== null;
    let lang: string = carryLang ?? "";
    for (const line of chunkBody.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("```")) {
        if (inCode) {
          inCode = false;
          lang = "";
        } else {
          inCode = true;
          const tag = stripped.slice(3).trim();
          lang = tag.split(/\s+/)[0] ?? "";
        }
      }
    }

    if (inCode) {
      fullChunk += FENCE_CLOSE; // close the orphaned fence so the chunk stands alone
      carryLang = lang;
    } else {
      carryLang = null;
    }

    chunks.push(fullChunk);
    // Advance the window instead of reassigning the big string (P-06).
    // Strip leading whitespace left at the split boundary so the next chunk
    // does not start with it (hermes: remaining[split_at:].lstrip()).
    pos = base + splitAt;
    while (pos < content.length && /^[ \t\n\r\f\v]$/.test(content[pos]!)) pos++;
  }

  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) => `${c} (${i + 1}/${total})`);
  }
  return chunks;
}
