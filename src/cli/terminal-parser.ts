/**
 * A virtual terminal (VT100/xterm subset) that turns a raw PTY byte stream into
 * a text screen.
 *
 * OpenCode ships an interactive TUI, so its stdout is a sequence of cursor
 * moves, screen clears, colour codes and buffer switches — NOT plain text.
 * RemoteCode feeds everything this class receives and renders a stable,
 * ANSI-free screen for Telegram (Terminal Mode).
 *
 * Design notes:
 *  - The parser is a resumable state machine: an escape sequence may be split
 *    across any number of `write()` calls and still parses correctly.
 *  - Cells share one frozen style object until an SGR changes the attributes,
 *    so a 120x40 screen plus scrollback costs far fewer objects than cells.
 *  - Everything is defensive: unknown sequences are consumed and dropped, and
 *    no input can make `write()` throw. A broken sequence must never take the
 *    bot down or leak raw escape codes to the user.
 *  - Query sequences the TUI may rely on (DSR cursor position, DA, OSC 11
 *    background colour) are answered through `onResponse`, otherwise some
 *    applications block waiting for a reply.
 */

import type { TerminalLine } from '../types.js';

/** Text attributes of one cell. Colors hold raw SGR parameter text. */
export interface CellStyle {
  /** Foreground: `30`-`37`, `90`-`97`, `38;5;n`, `38;2;r;g;b`; null = default. */
  fg: string | null;
  /** Background: `40`-`47`, `100`-`107`, `48;5;n`, `48;2;r;g;b`; null = default. */
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

/** One screen cell: a single character plus its attributes. */
export interface Cell {
  ch: string;
  style: CellStyle;
}

export interface CursorState {
  row: number;
  col: number;
  visible: boolean;
}

export interface VirtualTerminalOptions {
  /** Answers to terminal queries (DSR/DA/OSC). */
  onResponse?: (response: string) => void;
  /** Maximum scrollback lines kept for the main buffer. Default 500. */
  scrollback?: number;
}

const DEFAULT_STYLE: CellStyle = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

const DEFAULT_SCROLLBACK = 500;

/** Parser states. `osc-esc` = saw ESC inside an OSC payload, waiting for `\`. */
type ParserState = 'normal' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'charset' | 'hash';

function blankCell(): Cell {
  return { ch: ' ', style: DEFAULT_STYLE };
}

function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, blankCell);
}

function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => blankRow(cols));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class VirtualTerminal {
  private cols: number;

  private rows: number;

  /** Main screen buffer (scrollback lives on top of it). */
  private readonly mainGrid: Cell[][];

  /** Alternative screen buffer (DECSET 1049); null until first use. */
  private altGrid: Cell[][] | null = null;

  /** The buffer currently being painted (main or alt). */
  private grid: Cell[][];

  private readonly scrollback: Cell[][] = [];

  private readonly scrollbackLimit: number;

  private row = 0;

  private col = 0;

  private savedRow = 0;

  private savedCol = 0;

  private savedStyle: CellStyle = DEFAULT_STYLE;

  private style: CellStyle = DEFAULT_STYLE;

  /** True when the cursor sits one column past the last one (deferred wrap). */
  private pendingWrap = false;

  private scrollTop = 0;

  private scrollBottom: number;

  private cursorVisible = true;

  private wrapMode = true;

  /** Tab stops; index = column. */
  private tabs: boolean[];

  private state: ParserState = 'normal';

  /** Raw CSI parameter/intermediate text collected so far. */
  private csiBuf = '';

  /** Raw OSC payload collected so far. */
  private oscBuf = '';

  private readonly onResponse: ((response: string) => void) | undefined;

  private title = '';

  constructor(cols = 80, rows = 24, options: VirtualTerminalOptions = {}) {
    const width = Math.max(2, Math.floor(cols));
    const height = Math.max(2, Math.floor(rows));
    this.cols = width;
    this.rows = height;
    this.scrollBottom = height - 1;
    this.mainGrid = blankGrid(width, height);
    this.grid = this.mainGrid;
    this.scrollbackLimit = Math.max(0, options.scrollback ?? DEFAULT_SCROLLBACK);
    this.onResponse = options.onResponse;
    this.tabs = VirtualTerminal.defaultTabs(width);
  }

  private static defaultTabs(cols: number): boolean[] {
    const tabs = Array.from({ length: cols }, (_, index) => index % 8 === 0 && index > 0);
    return tabs;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Feed raw terminal output. Never throws, regardless of input. */
  write(chunk: string): void {
    if (typeof chunk !== 'string' || chunk.length === 0) return;

    for (let i = 0; i < chunk.length; i += 1) {
      const code = chunk.charCodeAt(i);

      // Surrogate pair → treat as a single printable character.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < chunk.length) {
        const next = chunk.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          this.printable(chunk.slice(i, i + 2));
          i += 1;
          continue;
        }
      }

      const ch = chunk.charAt(i);
      try {
        this.consume(ch, code);
      } catch {
        // A parser bug must never break the terminal session: resynchronise.
        this.state = 'normal';
        this.csiBuf = '';
        this.oscBuf = '';
      }
    }
  }

  /** Resize the screen, keeping overlapping content. */
  resize(cols: number, rows: number): void {
    const width = Math.max(2, Math.floor(cols));
    const height = Math.max(2, Math.floor(rows));
    if (width === this.cols && height === this.rows) return;

    const regrid = (source: Cell[][]): Cell[][] => {
      const next: Cell[][] = blankGrid(width, height);
      for (let r = 0; r < Math.min(source.length, height); r += 1) {
        const sourceRow = source[r];
        if (sourceRow === undefined) continue;
        for (let c = 0; c < Math.min(sourceRow.length, width); c += 1) {
          const cell = sourceRow[c];
          if (cell !== undefined) next[r]![c] = cell;
        }
      }
      return next;
    };

    // Regrid FIRST (regrid reads the old buffers), then swap their contents in
    // place so the `grid` reference stays valid.
    const nextMain = regrid(this.mainGrid);
    const nextAlt = this.altGrid === null ? null : regrid(this.altGrid);

    this.cols = width;
    this.rows = height;
    this.mainGrid.length = 0;
    this.mainGrid.push(...nextMain);
    if (this.altGrid !== null && nextAlt !== null) {
      this.altGrid.length = 0;
      this.altGrid.push(...nextAlt);
    }
    this.grid = this.altGrid ?? this.mainGrid;

    this.row = clamp(this.row, 0, height - 1);
    this.col = clamp(this.col, 0, width - 1);
    this.scrollTop = 0;
    this.scrollBottom = height - 1;
    this.pendingWrap = false;
    this.tabs = VirtualTerminal.defaultTabs(width);
  }

  /** Screen rows as plain text (no ANSI, trailing blanks trimmed). */
  render(): string[] {
    return this.grid.map((rowCells) => {
      let line = '';
      for (const cell of rowCells) line += cell.ch;
      return line.replace(/\s+$/u, '');
    });
  }

  /** Screen rows with SGR codes restored (used for richer previews). */
  renderAnsi(): string[] {
    return this.grid.map((rowCells) => {
      let line = '';
      let previous: CellStyle | null = null;
      for (const cell of rowCells) {
        if (cell.style !== previous) {
          line += VirtualTerminal.sgrOf(cell.style, previous);
          previous = cell.style;
        }
        line += cell.ch;
      }
      if (previous !== null && previous !== DEFAULT_STYLE) line += '\x1b[0m';
      return line.replace(/\s+$/u, '');
    });
  }

  /** Cursor position and visibility. */
  cursor(): CursorState {
    return {
      row: clamp(this.row, 0, this.rows - 1),
      col: clamp(this.col, 0, this.cols - 1),
      visible: this.cursorVisible,
    };
  }

  /** The last `lastN` screen rows as TerminalLine records. */
  toTerminalLines(lastN = 100): TerminalLine[] {
    const rendered = this.render();
    const limit = Math.max(1, Math.floor(lastN));
    const visible = rendered.slice(Math.max(0, rendered.length - limit));
    const offset = rendered.length - visible.length;
    return visible.map((text, index) => ({
      text,
      active: offset + index === this.row && this.cursorVisible,
    }));
  }

  /** Scrollback rows (oldest first), ANSI-free. */
  scrollbackLines(): string[] {
    return this.scrollback.map((rowCells) => {
      let line = '';
      for (const cell of rowCells) line += cell.ch;
      return line.replace(/\s+$/u, '');
    });
  }

  /** Reset everything (used by RIS and by tests). */
  clear(): void {
    for (let r = 0; r < this.mainGrid.length; r += 1) this.mainGrid[r] = blankRow(this.cols);
    this.altGrid = null;
    this.grid = this.mainGrid;
    this.scrollback.length = 0;
    this.row = 0;
    this.col = 0;
    this.style = DEFAULT_STYLE;
    this.pendingWrap = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.cursorVisible = true;
    this.wrapMode = true;
    this.state = 'normal';
    this.csiBuf = '';
    this.oscBuf = '';
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  get isAltBuffer(): boolean {
    return this.grid !== this.mainGrid;
  }

  get screenTitle(): string {
    return this.title;
  }

  // ── SGR rendering ─────────────────────────────────────────────────────────

  /** Builds the SGR sequence that turns `previous` into `next`. */
  private static sgrOf(next: CellStyle, previous: CellStyle | null): string {
    const base = previous ?? DEFAULT_STYLE;
    if (next === base) return '';
    const parts: string[] = [];

    if (next.fg !== base.fg || (next.fg === null && base.fg !== null)) {
      parts.push(next.fg ?? '39');
    }
    if (next.bg !== base.bg || (next.bg === null && base.bg !== null)) {
      parts.push(next.bg ?? '49');
    }
    if (next.bold !== base.bold) parts.push(next.bold ? '1' : '22');
    if (next.dim !== base.dim) parts.push(next.dim ? '2' : '22');
    if (next.italic !== base.italic) parts.push(next.italic ? '3' : '23');
    if (next.underline !== base.underline) parts.push(next.underline ? '4' : '24');
    if (next.inverse !== base.inverse) parts.push(next.inverse ? '7' : '27');

    // Attributes that changed away from a "reset-ish" value must start clean.
    const needsReset =
      (base.bold || base.dim || base.italic || base.underline || base.inverse) &&
      parts.includes('22');
    if (parts.length === 0) return '';
    return `\x1b[${needsReset ? '0;' : ''}${parts.join(';')}m`;
  }

  // ── character placement ───────────────────────────────────────────────────

  private printable(ch: string): void {
    if (this.pendingWrap) {
      this.col = 0;
      this.lineFeed();
      this.pendingWrap = false;
    }

    const row = this.grid[this.row];
    if (row === undefined) return;
    row[this.col] = { ch, style: this.style };

    if (this.col >= this.cols - 1) {
      if (this.wrapMode) this.pendingWrap = true;
    } else {
      this.col += 1;
    }
  }

  /** Move down one line, scrolling when the bottom of the region is reached. */
  private lineFeed(): void {
    if (this.row === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.row < this.rows - 1) {
      this.row += 1;
    }
  }

  private reverseIndex(): void {
    if (this.row === this.scrollTop) {
      this.scrollDown(1);
    } else if (this.row > 0) {
      this.row -= 1;
    }
  }

  private scrollUp(count: number): void {
    const n = clamp(count, 1, this.rows);
    for (let i = 0; i < n; i += 1) {
      const removed = this.grid.splice(this.scrollTop, 1)[0];
      if (removed === undefined) break;
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
      // Only the main buffer scrolls into history; alt-buffer output is transient.
      if (this.grid === this.mainGrid && this.scrollTop === 0) {
        this.scrollback.push(removed);
        const overflow = this.scrollback.length - this.scrollbackLimit;
        if (overflow > 0) this.scrollback.splice(0, overflow);
      }
    }
  }

  private scrollDown(count: number): void {
    const n = clamp(count, 1, this.rows);
    for (let i = 0; i < n; i += 1) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, blankRow(this.cols));
    }
  }

  private blankCells(fromCol: number, toCol: number): void {
    const row = this.grid[this.row];
    if (row === undefined) return;
    for (let c = Math.max(0, fromCol); c <= Math.min(this.cols - 1, toCol); c += 1) {
      row[c] = blankCell();
    }
  }

  // ── input state machine ───────────────────────────────────────────────────

  private consume(ch: string, code: number): void {
    switch (this.state) {
      case 'normal':
        this.consumeNormal(ch, code);
        return;
      case 'esc':
        this.consumeEsc(ch, code);
        return;
      case 'csi':
        this.consumeCsi(ch, code);
        return;
      case 'osc':
        this.consumeOsc(ch, code);
        return;
      case 'osc-esc':
        // ESC inside OSC: only ST (ESC \) terminates, anything else continues.
        if (ch === '\\') {
          this.endOsc();
        } else {
          this.oscBuf += '\x1b' + ch;
          this.state = 'osc';
        }
        return;
      case 'charset':
        // ESC ( X / ESC ) X: designate character set — consumed, not applied.
        this.state = 'normal';
        return;
      case 'hash':
        // ESC # 8: DEC alignment test — fill the screen with 'E'.
        this.state = 'normal';
        if (ch === '8') {
          for (let r = 0; r < this.rows; r += 1) {
            const row = this.grid[r];
            if (row === undefined) continue;
            for (let c = 0; c < this.cols; c += 1) row[c] = { ch: 'E', style: DEFAULT_STYLE };
          }
        }
        return;
      default:
        this.state = 'normal';
    }
  }

  private consumeNormal(ch: string, code: number): void {
    switch (code) {
      case 0x1b:
        this.state = 'esc';
        return;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.lineFeed();
        return;
      case 0x0d: // CR
        this.col = 0;
        this.pendingWrap = false;
        return;
      case 0x08: // BS
        if (this.col > 0) this.col -= 1;
        this.pendingWrap = false;
        return;
      case 0x09: // HT
        this.horizontalTab();
        return;
      case 0x07: // BEL
        return;
      case 0x7f: // DEL
        return;
      default:
        if (code < 0x20) return; // other C0 controls: ignored
        this.printable(ch);
    }
  }

  private horizontalTab(): void {
    let next = this.col + 1;
    while (next < this.cols && this.tabs[next] !== true) next += 1;
    this.col = Math.min(next, this.cols - 1);
    this.pendingWrap = false;
  }

  private consumeEsc(ch: string, code: number): void {
    this.state = 'normal';
    switch (ch) {
      case '[':
        this.state = 'csi';
        this.csiBuf = '';
        return;
      case ']':
        this.state = 'osc';
        this.oscBuf = '';
        return;
      case '(':
      case ')':
      case '*':
      case '+':
        this.state = 'charset';
        return;
      case '#':
        this.state = 'hash';
        return;
      case '7':
        this.saveCursor();
        return;
      case '8':
        this.restoreCursor();
        return;
      case 'D':
        this.lineFeed(); // IND
        return;
      case 'E':
        this.col = 0;
        this.lineFeed(); // NEL
        return;
      case 'M':
        this.reverseIndex(); // RI
        return;
      case 'c':
        this.hardReset(); // RIS
        return;
      case '=':
      case '>':
        return; // keypad modes: acknowledged, no effect on the screen
      case '\x1b':
        this.state = 'esc'; // ESC ESC: stay in escape state
        return;
      default:
        void code; // unknown two-byte escape: dropped
    }
  }

  private consumeCsi(ch: string, code: number): void {
    // Parameter bytes 0-9 : ; < = > ? and intermediates 0x20-0x2f accumulate.
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      if (this.csiBuf.length < 128) this.csiBuf += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      const raw = this.csiBuf;
      this.csiBuf = '';
      this.state = 'normal';
      this.dispatchCsi(raw, ch);
      return;
    }
    // Any other byte (including a stray ESC) aborts the sequence.
    this.state = code === 0x1b ? 'esc' : 'normal';
    this.csiBuf = '';
  }

  private consumeOsc(ch: string, code: number): void {
    if (code === 0x07) {
      this.endOsc();
      return;
    }
    if (code === 0x1b) {
      this.state = 'osc-esc';
      return;
    }
    if (this.oscBuf.length < 4096) this.oscBuf += ch;
  }

  private endOsc(): void {
    const payload = this.oscBuf;
    this.oscBuf = '';
    this.state = 'normal';
    this.handleOsc(payload);
  }

  // ── CSI dispatch ──────────────────────────────────────────────────────────

  private dispatchCsi(raw: string, final: string): void {
    const privateMark = raw.startsWith('?') || raw.startsWith('>') || raw.startsWith('<') || raw.startsWith('!');
    const body = privateMark ? raw.slice(1) : raw;
    const params = body
      .split(';')
      .map((part) => {
        const digits = /^\d+$/u.test(part) ? part : '';
        const value = digits === '' ? Number.NaN : Number.parseInt(digits, 10);
        return Number.isFinite(value) ? value : Number.NaN;
      });
    const p = (index: number, fallback: number): number => {
      const value = params[index];
      return value === undefined || Number.isNaN(value) ? fallback : value;
    };

    if (privateMark && (final === 'h' || final === 'l')) {
      this.setModes(params, final === 'h');
      return;
    }

    switch (final) {
      case 'A': // CUU
        this.row = clamp(this.row - p(0, 1), this.scrollTop, this.rows - 1);
        this.pendingWrap = false;
        return;
      case 'B': // CUD
        this.row = clamp(this.row + p(0, 1), 0, this.scrollBottom);
        this.pendingWrap = false;
        return;
      case 'C': // CUF
        this.col = clamp(this.col + p(0, 1), 0, this.cols - 1);
        this.pendingWrap = false;
        return;
      case 'D': // CUB
        this.col = clamp(this.col - p(0, 1), 0, this.cols - 1);
        this.pendingWrap = false;
        return;
      case 'E': // CNL
        this.col = 0;
        this.row = clamp(this.row + p(0, 1), 0, this.scrollBottom);
        this.pendingWrap = false;
        return;
      case 'F': // CPL
        this.col = 0;
        this.row = clamp(this.row - p(0, 1), this.scrollTop, this.rows - 1);
        this.pendingWrap = false;
        return;
      case 'G': // CHA
        this.col = clamp(p(0, 1) - 1, 0, this.cols - 1);
        this.pendingWrap = false;
        return;
      case 'H':
      case 'f': // CUP
        this.row = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.col = clamp(p(1, 1) - 1, 0, this.cols - 1);
        this.pendingWrap = false;
        return;
      case 'd': // VPA
        this.row = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.pendingWrap = false;
        return;
      case 'J': // ED
        this.eraseDisplay(p(0, 0));
        return;
      case 'K': // EL
        this.eraseLine(p(0, 0));
        return;
      case 'L': // IL
        this.insertLines(p(0, 1));
        return;
      case 'M': // DL
        this.deleteLines(p(0, 1));
        return;
      case '@': // ICH
        this.insertCharacters(p(0, 1));
        return;
      case 'P': // DCH
        this.deleteCharacters(p(0, 1));
        return;
      case 'X': // ECH
        this.blankCells(this.col, this.col + p(0, 1) - 1);
        return;
      case 'S': // SU
        this.scrollUp(p(0, 1));
        return;
      case 'T': // SD
        this.scrollDown(p(0, 1));
        return;
      case 'g': // TBC
        if (p(0, 0) === 3) this.tabs = Array.from({ length: this.cols }, () => false);
        else if (this.tabs[this.col] !== undefined) this.tabs[this.col] = false;
        return;
      case 'h': // SM (non-private)
        this.setStandardModes(params, true);
        return;
      case 'l': // RM (non-private)
        this.setStandardModes(params, false);
        return;
      case 'm': // SGR
        this.applySgr(params);
        return;
      case 'r': // DECSTBM
        this.setScrollRegion(p(0, 1), p(1, this.rows));
        return;
      case 's': // save cursor
        this.saveCursor();
        return;
      case 'u': // restore cursor
        this.restoreCursor();
        return;
      case 'n': // DSR
        if (p(0, 0) === 6) this.respond(`\x1b[${this.row + 1};${this.col + 1}R`);
        return;
      case 'c': // DA
        this.respond('\x1b[?6c');
        return;
      case 't': // window ops
      case 'p': //DECSTR / soft reset variants
        return;
      default:
        void raw; // unknown final byte: consumed and dropped
    }
  }

  private setModes(params: number[], enable: boolean): void {
    for (const value of params) {
      if (Number.isNaN(value)) continue;
      switch (value) {
        case 25:
          this.cursorVisible = enable;
          break;
        case 7:
          this.wrapMode = enable;
          if (!enable) this.pendingWrap = false;
          break;
        case 47:
        case 1047:
          this.switchAltBuffer(enable, false);
          break;
        case 1049:
          this.switchAltBuffer(enable, true);
          break;
        case 1:
        case 2:
        case 6:
        case 12:
        case 9:
        case 1000:
        case 1002:
        case 1003:
        case 1004:
        case 1005:
        case 1006:
        case 1015:
        case 2004:
          // Cursor keys / mouse / bracketed paste: tracked nowhere, harmless.
          break;
        default:
          break;
      }
    }
  }

  private setStandardModes(params: number[], enable: boolean): void {
    for (const value of params) {
      if (value === 4 && !enable) {
        this.style = { ...this.style, underline: false };
      }
    }
  }

  private switchAltBuffer(enable: boolean, saveCursor: boolean): void {
    if (enable) {
      if (this.grid === this.mainGrid) {
        if (saveCursor) this.saveCursor();
        this.altGrid = blankGrid(this.cols, this.rows);
        this.grid = this.altGrid;
        this.row = 0;
        this.col = 0;
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
        this.pendingWrap = false;
      }
      return;
    }
    if (this.grid === this.altGrid && this.altGrid !== null) {
      this.altGrid = null;
      this.grid = this.mainGrid;
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
      this.pendingWrap = false;
      if (saveCursor) this.restoreCursor();
    }
  }

  private saveCursor(): void {
    this.savedRow = this.row;
    this.savedCol = this.col;
    this.savedStyle = this.style;
  }

  private restoreCursor(): void {
    this.row = clamp(this.savedRow, 0, this.rows - 1);
    this.col = clamp(this.savedCol, 0, this.cols - 1);
    this.style = this.savedStyle;
    this.pendingWrap = false;
  }

  private setScrollRegion(topParam: number, bottomParam: number): void {
    const top = clamp(topParam - 1, 0, this.rows - 1);
    const bottom = clamp(bottomParam - 1, 0, this.rows - 1);
    if (top >= bottom) return;
    this.scrollTop = top;
    this.scrollBottom = bottom;
    this.row = 0;
    this.col = 0;
    this.pendingWrap = false;
  }

  private eraseDisplay(mode: number): void {
    switch (mode) {
      case 0:
        this.blankCells(this.col, this.cols - 1);
        for (let r = this.row + 1; r < this.rows; r += 1) this.grid[r] = blankRow(this.cols);
        return;
      case 1:
        for (let r = 0; r < this.row; r += 1) this.grid[r] = blankRow(this.cols);
        this.blankCells(0, this.col);
        return;
      case 2:
        for (let r = 0; r < this.rows; r += 1) this.grid[r] = blankRow(this.cols);
        return;
      case 3:
        this.scrollback.length = 0;
        return;
      default:
    }
  }

  private eraseLine(mode: number): void {
    switch (mode) {
      case 0:
        this.blankCells(this.col, this.cols - 1);
        return;
      case 1:
        this.blankCells(0, this.col);
        return;
      case 2:
        this.blankCells(0, this.cols - 1);
        return;
      default:
    }
  }

  private insertLines(count: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    const n = clamp(count, 1, this.rows);
    for (let i = 0; i < n; i += 1) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.row, 0, blankRow(this.cols));
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private deleteLines(count: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    const n = clamp(count, 1, this.rows);
    for (let i = 0; i < n; i += 1) {
      this.grid.splice(this.row, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private insertCharacters(count: number): void {
    const row = this.grid[this.row];
    if (row === undefined) return;
    const n = clamp(count, 1, this.cols - this.col);
    for (let i = 0; i < n; i += 1) {
      row.splice(this.col, 0, blankCell());
      row.pop();
    }
    this.pendingWrap = false;
  }

  private deleteCharacters(count: number): void {
    const row = this.grid[this.row];
    if (row === undefined) return;
    const n = clamp(count, 1, this.cols - this.col);
    for (let i = 0; i < n; i += 1) {
      row.splice(this.col, 1);
      row.push(blankCell());
    }
    this.pendingWrap = false;
  }

  private hardReset(): void {
    this.clear();
    this.savedRow = 0;
    this.savedCol = 0;
    this.savedStyle = DEFAULT_STYLE;
  }

  // ── SGR parsing ───────────────────────────────────────────────────────────

  private applySgr(params: number[]): void {
    const list = params.length === 0 || (params.length === 1 && Number.isNaN(params[0]!))
      ? [0]
      : params;

    const next: CellStyle = { ...this.style };
    for (let i = 0; i < list.length; i += 1) {
      const value = Number.isNaN(list[i]!) ? 0 : list[i]!;

      switch (value) {
        case 0:
          Object.assign(next, DEFAULT_STYLE);
          break;
        case 1:
          next.bold = true;
          break;
        case 2:
          next.dim = true;
          break;
        case 3:
          next.italic = true;
          break;
        case 4:
          next.underline = true;
          break;
        case 7:
          next.inverse = true;
          break;
        case 22:
          next.bold = false;
          next.dim = false;
          break;
        case 23:
          next.italic = false;
          break;
        case 24:
          next.underline = false;
          break;
        case 27:
          next.inverse = false;
          break;
        case 39:
          next.fg = null;
          break;
        case 49:
          next.bg = null;
          break;
        case 38:
        case 48: {
          const consumed = VirtualTerminal.readExtendedColor(list, i, value === 38);
          if (consumed === null) break;
          if (value === 38) next.fg = consumed.color;
          else next.bg = consumed.color;
          i += consumed.consumed;
          break;
        }
        default:
          if (value >= 30 && value <= 37) next.fg = String(value);
          else if (value >= 40 && value <= 47) next.bg = String(value);
          else if (value >= 90 && value <= 97) next.fg = String(value);
          else if (value >= 100 && value <= 107) next.bg = String(value);
          break;
      }
    }

    // Style objects are interned per attribute set so cells can share them.
    this.style = VirtualTerminal.internStyle(next);
  }

  /** Parses `38;5;n` / `38;2;r;g;b` starting at `index`; returns consumed count. */
  private static readExtendedColor(
    list: number[],
    index: number,
    _isForeground: boolean,
  ): { color: string; consumed: number } | null {
    const mode = list[index + 1];
    if (mode === 5) {
      const n = list[index + 2];
      if (n === undefined || Number.isNaN(n)) return null;
      const color = `${_isForeground ? '38' : '48'};5;${clamp(Math.trunc(n), 0, 255)}`;
      return { color, consumed: 2 };
    }
    if (mode === 2) {
      const r = list[index + 2];
      const g = list[index + 3];
      const b = list[index + 4];
      if (r === undefined || g === undefined || b === undefined) return null;
      const part = (value: number): string =>
        String(clamp(Number.isNaN(value) ? 0 : Math.trunc(value), 0, 255));
      const color = `${_isForeground ? '38' : '48'};2;${part(r)};${part(g)};${part(b)}`;
      return { color, consumed: 4 };
    }
    return null;
  }

  /** Returns a canonical (frozen) style equal to `style` for interning. */
  private static styleCache = new Map<string, CellStyle>();

  private static internStyle(style: CellStyle): CellStyle {
    const key =
      `${style.fg}|${style.bg}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}` +
      `${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.inverse ? 1 : 0}`;
    const cached = VirtualTerminal.styleCache.get(key);
    if (cached !== undefined) return cached;
    const frozen = Object.freeze({ ...style });
    VirtualTerminal.styleCache.set(key, frozen);
    if (VirtualTerminal.styleCache.size > 512) VirtualTerminal.styleCache.clear();
    return frozen;
  }

  // ── terminal query answers ────────────────────────────────────────────────

  private handleOsc(payload: string): void {
    const separator = payload.indexOf(';');
    const code = separator < 0 ? payload : payload.slice(0, separator);
    const value = separator < 0 ? '' : payload.slice(separator + 1);

    if (code === '0' || code === '2') {
      this.title = value.slice(0, 256);
      return;
    }
    if (code === '11' && value.endsWith('?')) {
      // Background colour query: answer "black" so themes settle deterministically.
      this.respond('\x1b]11;rgb:0000/0000/0000\x1b\\');
    }
  }

  private respond(data: string): void {
    try {
      this.onResponse?.(data);
    } catch {
      // A broken response handler must not corrupt the screen.
    }
  }
}
