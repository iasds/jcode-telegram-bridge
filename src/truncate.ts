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
  let remaining = content;
  let carryLang: string | null = null;

  while (remaining) {
    // Reopen a code block carried from the previous chunk.
    const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : "";

    let headroom = maxLength - INDICATOR_RESERVE - prefix.length - FENCE_CLOSE.length;
    if (headroom < 1) headroom = Math.max(1, Math.floor(maxLength / 2));

    // Everything remaining fits in one final chunk.
    if (prefix.length + remaining.length <= maxLength - INDICATOR_RESERVE) {
      chunks.push(prefix + remaining);
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
    remaining = remaining.slice(splitAt);
  }

  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) => `${c} (${i + 1}/${total})`);
  }
  return chunks;
}
