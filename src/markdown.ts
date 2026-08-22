/**
 * Telegram MarkdownV2 rendering.
 *
 * Ported from hermes-agent (NousResearch/hermes-agent, open source):
 *   plugins/platforms/telegram/adapter.py  -> format_message() 12-step pipeline
 *   gateway/platforms/helpers.py           -> convert_table_to_bullets()
 *
 * Strategy: protect code spans, convert markdown constructs to MarkdownV2,
 * escape the rest, restore protected spans, then a safety net for bare parens.
 */

const MDV2_ESCAPE_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMdv2(text: string): string {
  return text.replace(MDV2_ESCAPE_RE, "\\$1");
}

export function stripMdv2(text: string): string {
  let cleaned = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");
  cleaned = cleaned.replace(/~([^~]+)~/g, "$1");
  cleaned = cleaned.replace(/\|\|([^|]+)\|\|/g, "$1");
  return cleaned;
}

// ── Table -> bullet groups (helpers.py) ──────────────────────────────────

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;

function isTableRow(line: string): boolean {
  const stripped = line.trim();
  return stripped !== "" && stripped.includes("|");
}

function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith("|")) stripped = stripped.slice(1);
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
  return stripped.split("|").map((cell) => cell.trim());
}

function renderTableBlock(block: string[]): string {
  if (block.length < 3) return block.join("\n");
  const headers = splitTableRow(block[0]);
  if (headers.length < 2) return block.join("\n");
  const firstDataRow = block.length > 2 ? splitTableRow(block[2]) : [];
  const hasRowLabelCol = firstDataRow.length === headers.length + 1;

  const groups: string[] = [];
  for (let index = 0; index < block.length - 2; index++) {
    const row = block[index + 2];
    const cells = splitTableRow(row);
    let heading: string;
    let dataCells: string[];
    if (hasRowLabelCol) {
      heading = cells[0] && cells[0] !== "" ? cells[0] : `Row ${index + 1}`;
      dataCells = cells.slice(1);
    } else {
      heading = cells.find((c) => c !== "") ?? `Row ${index + 1}`;
      dataCells = cells;
    }
    if (dataCells.length < headers.length) {
      while (dataCells.length < headers.length) dataCells.push("");
    } else if (dataCells.length > headers.length) {
      dataCells = dataCells.slice(0, headers.length);
    }
    const bullets: string[] = [];
    headers.forEach((header, i) => {
      const value = dataCells[i] ?? "";
      if (!hasRowLabelCol && value === heading) return;
      bullets.push(`• ${header}: ${value}`);
    });
    groups.push(`**${heading}**\n${bullets.join("\n")}`);
  }
  return groups.join("\n\n");
}

/** Rewrite GFM pipe tables into bold-heading + bullet groups. */
export function convertTableToBullets(text: string): string {
  if (!text.includes("|") || !text.includes("-")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trimStart();
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      const block = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      out.push(renderTableBlock(block));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ── format_message pipeline (adapter.py) ─────────────────────────────────

/** Convert standard markdown to Telegram MarkdownV2 format. */
export function formatMessage(content: string): string {
  if (!content) return content;

  // Security (w1 review): strip C0 control chars EXCEPT \n (and \t for tables).
  // The Bot API rejects U+0000 in sendMessage, so a hostile caption containing
  // NUL would otherwise make every reply to that chat fail silently.
  // eslint-disable-next-line no-control-regex
  content = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (!content) return content;

  const placeholders = new Map<string, string>();
  // Per-call random prefix (w1 review #7): an attacker-crafted literal
  // "\u0000PH0\u0000" in the input can no longer collide with a real key.
  const nonce = Math.random().toString(36).slice(2, 8);
  let counter = 0;
  const ph = (value: string): string => {
    const key = `\u0000${nonce}PH${counter}\u0000`;
    counter++;
    placeholders.set(key, value);
    return key;
  };

  let text = content;

  // 0) GFM pipe tables -> Telegram-friendly groups
  text = convertTableToBullets(text);

  // 1) Protect fenced code blocks (``` ... ```); escape \ and ` inside.
  text = text.replace(/```(?:[^\n]*\n)?[\s\S]*?```/g, (raw) => {
    const newlineInBody = raw.indexOf("\n", 3);
    const openEnd = newlineInBody !== -1 ? newlineInBody + 1 : 3;
    const opening = raw.slice(0, openEnd);
    const bodyAndClose = raw.slice(openEnd);
    const body = bodyAndClose.slice(0, -3);
    const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    return ph(opening + escaped + "```");
  });

  // 2) Protect inline code (`...`); escape \ inside.
  text = text.replace(/`[^`\n]+`/g, (m) => ph(m.replace(/\\/g, "\\\\")));

  // 3) Convert markdown links; escape display text; escape \ and ) in URL.
  text = text.replace(
    /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_m, display: string, url: string) =>
      ph(`[${escapeMdv2(display)}](${url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)")})`),
  );

  // 4) Headers (## Title) -> bold *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner: string) => {
    const cleaned = inner.trim().replace(/\*\*(.+?)\*\*/g, "$1");
    return ph(`*${escapeMdv2(cleaned)}*`);
  });

  // 5) Bold: **text** -> *text*
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) => ph(`*${escapeMdv2(inner)}*`));

  // 6) Italic: *text* -> _text_ (single line only, keep bullet lists intact)
  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner: string) => ph(`_${escapeMdv2(inner)}_`));

  // 7) Strikethrough: ~~text~~ -> ~text~
  text = text.replace(/~~(.+?)~~/g, (_m, inner: string) => ph(`~${escapeMdv2(inner)}~`));

  // 8) Spoiler: ||text|| -> ||text|| (protect from | escaping)
  text = text.replace(/\|\|(.+?)\|\|/g, (_m, inner: string) => ph(`||${escapeMdv2(inner)}||`));

  // 9) Blockquotes: line-start > protected from escaping
  text = text.replace(/^((?:\*\*)?>{1,3}) (.+)$/gm, (_m, prefix: string, rest: string) => {
    if (prefix.startsWith("**") && rest.endsWith("||")) {
      return ph(`${prefix} ${escapeMdv2(rest.slice(0, -2))}||`);
    }
    return ph(`${prefix} ${escapeMdv2(rest)}`);
  });

  // 10) Escape remaining special characters
  text = escapeMdv2(text);

  // 11) Restore placeholders in ONE pass over the text (P-05; was: a
  // split/join scan of the full text per placeholder, O(n·p²)). Nested refs
  // resolve depth-first inside the replacer, preserving the old
  // reverse-insertion-order semantics. Work is linear in output size.
  // A fresh /g regex per recursion level avoids lastIndex reentrancy.
  const keyRe = new RegExp(`\u0000${nonce}PH([0-9]+)\u0000`, "g");
  const restorePlaceholders = (s: string): string =>
    s.replace(keyRe, (tok, i: string) => {
      const value = placeholders.get(`\u0000${nonce}PH${i}\u0000`);
      // Unknown index: leave the token verbatim (legacy split/join parity —
      // only keys present in the map were ever replaced).
      return value === undefined ? tok : restorePlaceholders(value);
    });
  text = restorePlaceholders(text);

  // 12) Safety net: escape bare ( ) { } outside code spans.
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  const safe: string[] = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const seg = parts[idx];
    if (idx % 2 === 1) {
      safe.push(seg); // inside code span/block — untouched
      continue;
    }
    safe.push(
      seg.replace(/[(){}]/g, (ch, pos: number) => {
        if (pos > 0 && seg[pos - 1] === "\\") return ch; // already escaped
        if (ch === "(" && pos > 0 && seg[pos - 1] === "]") return ch; // link open
        if (ch === ")") {
          const before = seg.slice(0, pos);
          if (before.includes("](")) {
            let depth = 0;
            for (let j = pos - 1; j >= 0 && j > pos - 2000; j--) {
              if (seg[j] === "(") {
                depth -= 1;
                if (depth < 0) {
                  if (j > 0 && seg[j - 1] === "]") return ch;
                  break;
                }
              } else if (seg[j] === ")") {
                depth += 1;
              }
            }
          }
        }
        return "\\" + ch;
      }),
    );
  }
  return safe.join("");
}
