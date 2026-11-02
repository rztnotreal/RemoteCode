import { describe, it, expect } from 'vitest';
import {
  escapeMarkdownV2,
  splitMessage,
  stripAnsi,
  truncateMiddle,
} from '../src/utils/telegram-text.js';

describe('escapeMarkdownV2', () => {
  it('escapes every MarkdownV2 special character', () => {
    expect(escapeMarkdownV2('Hello, World!')).toBe('Hello, World\\!');
    expect(escapeMarkdownV2('a_b*c[d]e(f)g')).toBe('a\\_b\\*c\\[d\\]e\\(f\\)g');
    expect(escapeMarkdownV2('`~>#+-=|{}.!')).toBe('\\`\\~\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!');
    expect(escapeMarkdownV2('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text and emoji untouched', () => {
    expect(escapeMarkdownV2('héllo wörld 🌍 123')).toBe('héllo wörld 🌍 123');
  });
});

describe('splitMessage', () => {
  it('returns a single chunk for short text', () => {
    expect(splitMessage('hello world')).toEqual(['hello world']);
    expect(splitMessage('x', 4000)).toEqual(['x']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitMessage('')).toEqual([]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => splitMessage('abc', 0)).toThrow(RangeError);
  });

  it('never loses characters and respects the limit on mixed text', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with some words here.`).join('\n\n');
    const limit = 500;
    const chunks = splitMessage(text, limit);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('splits on line boundaries when lines are present', () => {
    const text = 'some line of text\n'.repeat(300);
    const chunks = splitMessage(text, 100);

    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.endsWith('\n')).toBe(true);
    }
  });

  it('splits on word boundaries when there are no newlines', () => {
    const text = 'word '.repeat(1000);
    const chunks = splitMessage(text, 400);

    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
      expect(chunk.endsWith(' ')).toBe(true);
    }
  });

  it('hard-splits when no boundary exists', () => {
    const text = 'a'.repeat(9500);
    const chunks = splitMessage(text, 4000);

    expect(chunks).toEqual(['a'.repeat(4000), 'a'.repeat(4000), 'a'.repeat(1500)]);
    expect(chunks.join('')).toBe(text);
  });

  it('preserves multi-byte characters across splits', () => {
    const text = '🌍'.repeat(3000);
    const chunks = splitMessage(text, 1000);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });
});

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
    expect(truncateMiddle('exactly', 7)).toBe('exactly');
  });

  it('keeps head and tail with an omission marker, exactly at max', () => {
    const text = 'A'.repeat(50) + 'MIDDLE-DROP' + 'Z'.repeat(50);
    const result = truncateMiddle(text, 40);

    expect(result.length).toBe(40);
    expect(result.startsWith('A')).toBe(true);
    expect(result.endsWith('Z')).toBe(true);

    const match = /… \((\d+) chars omitted\)/.exec(result);
    expect(match).not.toBeNull();
    const omitted = Number(match?.[1]);
    const marker = match?.[0] ?? '';
    const head = result.indexOf(marker);
    const tail = result.length - (head + marker.length);
    expect(head + omitted + tail).toBe(text.length);
    expect(result.slice(0, head)).toBe(text.slice(0, head));
    expect(result.slice(head + marker.length)).toBe(text.slice(text.length - tail));
  });

  it('hard-cuts when max is too small for the marker', () => {
    const result = truncateMiddle('abcdefghij', 3);
    expect(result.length).toBeLessThanOrEqual(3);
    expect('abcdefghij'.startsWith(result)).toBe(true);
  });

  it('rejects a non-positive max', () => {
    expect(() => truncateMiddle('abc', 0)).toThrow(RangeError);
  });
});

describe('stripAnsi', () => {
  it('removes CSI color sequences while keeping the text', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripAnsi('\u001b[1;32mOK\u001b[0m done')).toBe('OK done');
  });

  it('removes OSC sequences terminated by BEL or ST', () => {
    expect(stripAnsi('\u001b]0;window title\u0007text')).toBe('text');
    expect(stripAnsi('\u001b]8;;http://example.com\u001b\\link')).toBe('link');
  });

  it('removes single-character escapes and stray controls', () => {
    expect(stripAnsi('\u001bMx')).toBe('x');
    expect(stripAnsi('a\u0007b\nc\td')).toBe('ab\nc\td');
  });

  it('converts CRLF to LF', () => {
    expect(stripAnsi('line1\r\nline2\r\n')).toBe('line1\nline2\n');
  });

  it('preserves newlines, tabs and multi-byte characters', () => {
    const text = 'héllo\nwörld\t🌍\n';
    expect(stripAnsi(text)).toBe(text);
    expect(stripAnsi('\u001b[32m🌍\u001b[0m')).toBe('🌍');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});
