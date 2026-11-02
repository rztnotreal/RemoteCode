import { describe, it, expect } from 'vitest';

import { VirtualTerminal } from '../src/cli/terminal-parser.js';

/**
 * Virtual terminal tests.
 *
 * The TUI drives this screen, so these cases pin down exactly what Telegram
 * will show: cursor handling, clearing, scrolling, colours, the alternative
 * buffer and — importantly — escape sequences SPLIT across writes.
 */

function screen(term: VirtualTerminal): string[] {
  return term.render();
}

describe('plain output', () => {
  it('places printable text and trims trailing blanks', () => {
    const term = new VirtualTerminal(20, 5);
    term.write('Hello');
    expect(screen(term)[0]).toBe('Hello');
    expect(screen(term)[1]).toBe('');
    expect(term.cursor()).toEqual({ row: 0, col: 5, visible: true });
  });

  it('moves to the next line on CR/LF pairs', () => {
    const term = new VirtualTerminal(20, 5);
    term.write('one\r\ntwo');
    expect(screen(term).slice(0, 2)).toEqual(['one', 'two']);
    expect(term.cursor()).toEqual({ row: 1, col: 3, visible: true });
  });

  it('wraps long lines at the right margin', () => {
    const term = new VirtualTerminal(5, 5);
    term.write('abcdefg');
    expect(screen(term)[0]).toBe('abcde');
    expect(screen(term)[1]).toBe('fg');
    expect(term.cursor().row).toBe(1);
  });

  it('handles a tab and a backspace', () => {
    const term = new VirtualTerminal(20, 5);
    term.write('a\tb\b!');
    expect(screen(term)[0]).toBe('a       !');
  });

  it('ignores unknown control characters without throwing', () => {
    const term = new VirtualTerminal(10, 3);
    expect(() => term.write('\x00\x05\x1bZ\x1b[999Z')).not.toThrow();
    expect(screen(term)[0]).toBe('');
  });
});

describe('cursor addressing', () => {
  it('picks a cell with CUP and writes there', () => {
    const term = new VirtualTerminal(20, 6);
    term.write('\x1b[3;5HX');
    expect(screen(term)[2]).toBe('    X');
    expect(term.cursor()).toEqual({ row: 2, col: 5, visible: true });
  });

  it('supports CHA, VPA and relative moves', () => {
    const term = new VirtualTerminal(20, 6);
    term.write('\x1b[7G'); // column 7 (1-based) → index 6
    term.write('\x1b[4d'); // row 4 → index 3
    term.write('A');
    expect(screen(term)[3]).toBe('      A');

    term.write('\x1b[2D'); // move left 2 (cursor is at col 7 after 'A')
    term.write('B');
    // col 6='A', cursor back to 5 → 'B' lands at index 5, index 6 keeps 'A'.
    expect(screen(term)[3]).toBe('     BA');
  });

  it('hides and shows the cursor with DECSET 25', () => {
    const term = new VirtualTerminal(10, 3);
    expect(term.cursor().visible).toBe(true);
    term.write('\x1b[?25l');
    expect(term.cursor().visible).toBe(false);
    term.write('\x1b[?25h');
    expect(term.cursor().visible).toBe(true);
  });
});

describe('erasing', () => {
  it('clears the screen with ED 2', () => {
    const term = new VirtualTerminal(10, 3);
    term.write('aaa\r\nbbb\r\nccc\x1b[2J');
    expect(screen(term)).toEqual(['', '', '']);
  });

  it('erases to the end of the line with EL 0', () => {
    const term = new VirtualTerminal(10, 2);
    term.write('abcdef\x1b[3G\x1b[0K');
    expect(screen(term)[0]).toBe('ab');
  });

  it('erases from the start of the line with EL 1', () => {
    const term = new VirtualTerminal(10, 2);
    term.write('abcdef\x1b[3G\x1b[1K');
    expect(screen(term)[0]).toBe('   def');
  });
});

describe('scrolling', () => {
  it('scrolls past the last row into scrollback', () => {
    const term = new VirtualTerminal(10, 3);
    term.write('l1\r\nl2\r\nl3\r\nl4');
    expect(screen(term)).toEqual(['l2', 'l3', 'l4']);
    expect(term.scrollbackLines()).toEqual(['l1']);
  });

  it('honours the scroll region', () => {
    const term = new VirtualTerminal(10, 5);
    term.write('top\r\na\r\nb\r\nc\r\nbottom');
    term.write('\x1b[2;4r'); // region = rows 2..4 (indices 1..3); cursor homes
    term.write('\x1b[4;1H'); // region's bottom row ('c')
    term.write('\r\nX'); // LF at the region bottom → only the region scrolls
    const lines = screen(term);
    expect(lines).toEqual(['top', 'b', 'c', 'X', 'bottom']);
    expect(lines[0]).toBe('top'); // above the region: untouched
    expect(lines[4]).toBe('bottom'); // below the region: untouched
  });

  it('inserts and deletes lines inside the region', () => {
    const term = new VirtualTerminal(10, 5);
    term.write('a\r\nb\r\nc\r\nd\r\ne'); // rows 0..4, cursor on the last one
    term.write('\x1b[2;1H'); // row index 1 = 'b'
    term.write('\x1b[L'); // insert line → the bottom line is pushed off
    expect(screen(term)).toEqual(['a', '', 'b', 'c', 'd']);
    term.write('\x1b[M'); // delete line → a blank line returns at the bottom
    expect(screen(term)).toEqual(['a', 'b', 'c', 'd', '']);
  });
});

describe('colours (SGR)', () => {
  it('applies and resets attributes', () => {
    const term = new VirtualTerminal(20, 3);
    term.write('\x1b[1;31mred\x1b[0m plain');
    const ansi = term.renderAnsi()[0] ?? '';
    expect(ansi).toContain('\x1b[');
    expect(ansi).toContain('red');
    expect(ansi.replace(/\x1b\[[0-9;]*m/gu, '')).toBe('red plain');
  });

  it('distinguishes coloured and plain cells', () => {
    const term = new VirtualTerminal(20, 3);
    term.write('\x1b[32mGREEN\x1b[0m');
    const plain = screen(term)[0];
    expect(plain).toBe('GREEN'); // plain render never leaks escape codes
  });

  it('supports 256-colour and true-colour parameters', () => {
    const term = new VirtualTerminal(30, 3);
    expect(() => term.write('\x1b[38;5;208mA\x1b[0m\x1b[38;2;10;20;30mB\x1b[0m')).not.toThrow();
    expect(screen(term)[0]).toBe('AB');
  });
});

describe('alternative screen buffer', () => {
  it('switches to the alt buffer and restores the main screen', () => {
    const term = new VirtualTerminal(20, 4);
    term.write('MAIN SCREEN');
    term.write('\x1b[?1049h');
    expect(term.isAltBuffer).toBe(true);
    expect(screen(term)[0]).toBe(''); // alt buffer starts empty

    term.write('ALT ONLY');
    expect(screen(term)[0]).toBe('ALT ONLY');

    term.write('\x1b[?1049l');
    expect(term.isAltBuffer).toBe(false);
    expect(screen(term)[0]).toBe('MAIN SCREEN'); // main content survived
  });
});

describe('robustness against chunked input', () => {
  it('parses an escape sequence split across several writes', () => {
    const term = new VirtualTerminal(20, 4);
    term.write('\x1b');
    term.write('[');
    term.write('3');
    term.write(';');
    term.write('5');
    term.write('H');
    term.write('X');
    expect(screen(term)[2]).toBe('    X');
  });

  it('parses an OSC title split across writes and keeps it out of the screen', () => {
    const term = new VirtualTerminal(20, 3);
    term.write('\x1b]0;my ti');
    term.write('tle\x07after');
    expect(screen(term)[0]).toBe('after');
    expect(term.screenTitle).toBe('my title');
  });

  it('handles a surrogate pair split across writes', () => {
    const term = new VirtualTerminal(10, 3);
    term.write('\ud83d');
    term.write('\ude00');
    expect(screen(term)[0]).toBe('😀');
  });

  it('never throws on arbitrary junk', () => {
    const term = new VirtualTerminal(12, 4);
    const junk = '\x1b[[[[;;;m\x1b]?????\x1b#\x1b)0\x07\x1b[38;5;m';
    expect(() => term.write(junk)).not.toThrow();
  });
});

describe('terminal queries', () => {
  it('answers DSR cursor position reports', () => {
    const responses: string[] = [];
    const term = new VirtualTerminal(20, 5, { onResponse: (data) => responses.push(data) });
    term.write('\x1b[2;3H');
    term.write('\x1b[6n');
    expect(responses).toEqual(['\x1b[2;3R']);
  });

  it('answers the background colour query', () => {
    const responses: string[] = [];
    const term = new VirtualTerminal(20, 5, { onResponse: (data) => responses.push(data) });
    term.write('\x1b]11;?\x1b\\');
    expect(responses.length).toBe(1);
    expect(responses[0]).toContain('rgb:');
  });
});

describe('resize', () => {
  it('keeps content inside the new bounds', () => {
    const term = new VirtualTerminal(20, 5);
    term.write('first\r\nsecond');
    term.resize(10, 3);
    expect(screen(term)).toEqual(['first', 'second', '']);
    expect(term.size).toEqual({ cols: 10, rows: 3 });

    term.write('\x1b[10;1H');
    expect(term.cursor().col).toBeLessThan(10);
  });
});

describe('toTerminalLines', () => {
  it('marks the cursor row as active and limits the tail', () => {
    const term = new VirtualTerminal(10, 4);
    term.write('a\r\nb\r\nc\r\nd'); // cursor ends on the LAST row
    const lines = term.toTerminalLines(2);
    expect(lines.map((line) => line.text)).toEqual(['c', 'd']);
    expect(lines[1]?.active).toBe(true);
    expect(lines[0]?.active).toBe(false);
  });
});
