/**
 * Fake TUI for PTY tests: emits a realistic sequence of terminal escape codes
 * in several chunks (including a sequence split across two writes) and then
 * exits with code 0 — like a TUI that finished its job.
 *
 * Stages:
 *   1. clear screen + home cursor
 *   2. plain text line
 *   3. colourised line (SGR)
 *   4. cursor addressing: write at row 10, col 5
 *   5. ESC [  split across two writes (parser must resume)
 *   6. alternative screen buffer ON  → text visible only there
 *   7. alternative screen buffer OFF → main screen restored
 *   8. plain lines at the bottom
 *
 * A ref'd safety timer guarantees the process can never hang a test run even
 * if the stage timer misbehaves.
 */
'use strict';

const stages = [
  '\x1b[2J\x1b[H',
  'Hello RemoteCode\r\n',
  '\x1b[31mRED\x1b[0m plain\r\n',
  '\x1b[10;5HAt row 10 col 5',
  '\x1b[', // ← sequence starts here…
  '32mGREEN after split\x1b[0m\r\n',
  '\x1b[?1049hALT BUFFER ONLY',
  '\x1b[?1049l',
  '\r\nline before scroll\r\nline that scrolls off\r\nbottom line',
];

let index = 0;

const stageTimer = setInterval(() => {
  if (index >= stages.length) {
    clearInterval(stageTimer);
    // Give the PTY reader a beat to drain, then exit like a finished TUI.
    setTimeout(() => process.exit(0), 80);
    return;
  }
  process.stdout.write(stages[index]);
  index += 1;
}, 40);

// Safety net: never let a test wait longer than this.
setTimeout(() => process.exit(0), 30_000);
