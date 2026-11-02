/**
 * Helpers for fitting text into Telegram's 4096-character message limit.
 */

/** Characters that must be escaped in MarkdownV2 parse mode. */
const MARKDOWN_V2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIALS, '\\$&');
}

/**
 * Splits `text` into chunks of at most `limit` characters.
 *
 * Chunks are cut on paragraph (`\n\n`) boundaries first, then line (`\n`)
 * boundaries, then spaces; only when no sensible boundary exists is the
 * chunk hard-split at exactly `limit`. Concatenating the result always
 * reproduces the input byte-for-byte: no characters are dropped or
 * reordered. Empty input yields an empty array.
 */
export function splitMessage(text: string, limit = 4000): string[] {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`splitMessage: limit must be a positive number, received ${limit}`);
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;

    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= 0 && paragraph + 2 > limit * 0.5) {
      cut = paragraph + 2;
    }

    if (cut < 0) {
      const line = window.lastIndexOf('\n');
      if (line >= 0 && line + 1 > limit * 0.5) {
        cut = line + 1;
      }
    }

    if (cut < 0) {
      const word = window.lastIndexOf(' ');
      if (word > 0 && word + 1 > limit * 0.5) {
        cut = word + 1;
      }
    }

    if (cut <= 0 || cut > limit) {
      cut = limit; // No usable boundary: hard-split.
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

function markerFor(omitted: number): string {
  return `… (${omitted} chars omitted)`;
}

/**
 * Truncates `text` to at most `max` characters by dropping the middle and
 * inserting an `… (N chars omitted)` marker. Short text is returned as-is.
 */
export function truncateMiddle(text: string, max: number): string {
  if (!Number.isFinite(max) || max < 1) {
    throw new RangeError(`truncateMiddle: max must be a positive number, received ${max}`);
  }
  if (text.length <= max) {
    return text;
  }

  // Grow head/tail until the marker length (which shrinks as fewer characters
  // are omitted) stops changing, so the result lands exactly on `max`.
  let head = 0;
  let tail = 0;
  for (let i = 0; i < 4; i += 1) {
    const omitted = text.length - head - tail;
    const budget = max - markerFor(omitted).length;
    if (budget <= 0) break;
    const nextHead = Math.ceil(budget / 2);
    const nextTail = budget - nextHead;
    if (nextHead === head && nextTail === tail) break;
    head = nextHead;
    tail = nextTail;
  }

  if (head + tail <= 0) {
    // `max` is too small to hold the marker; hard-cut instead.
    return text.slice(0, max);
  }

  const omitted = text.length - head - tail;
  return text.slice(0, head) + markerFor(omitted) + text.slice(text.length - tail);
}

// CSI: ESC [ params intermediate final-byte (final byte in @-~).
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] body, terminated by BEL or ST (ESC \). Body must not contain ESC/BEL.
const OSC_RE = /\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g;
// Two-character escapes: ESC followed by any printable byte.
const ESC_SINGLE_RE = /\x1b[\x30-\x7e]/g;
// Any ESC left over after the structured sequences were removed.
const LONE_ESC_RE = /\x1b/g;
// Stray C0 controls and DEL, preserving tab (\t) and newline (\n).
const STRAY_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Removes ANSI/VT escape sequences (CSI, OSC, single-char escapes) and stray
 * control characters while preserving `\n` and `\t`. Operates on decoded JS
 * strings only, so multi-byte UTF-8 characters are never corrupted.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(LONE_ESC_RE, '')
    .replace(STRAY_CONTROL_RE, '');
}
