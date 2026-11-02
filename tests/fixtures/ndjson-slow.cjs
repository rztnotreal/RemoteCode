/**
 * Fixture that starts producing output and then stays busy for a long time.
 *
 * Used for cancellation and hang-guard tests: the run emits a first text part,
 * then nothing until `--delay=` ms have passed (default 60s).
 */
'use strict';

const args = process.argv.slice(2);

const delayArg = args.find((arg) => arg.startsWith('--delay='));
const delayMs = delayArg ? Number.parseInt(delayArg.slice('--delay='.length), 10) : 60_000;
const message = args.length > 0 ? args[args.length - 1] : '';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// Unique per process: each test run proves that sessions stay isolated.
const sessionId = `ses_slow_${Math.random().toString(36).slice(2, 10)}`;

emit({ type: 'step_start', timestamp: Date.now(), sessionID: sessionId, part: { type: 'step-start' } });
emit({
  type: 'text',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: { id: 'prt_slow_start', type: 'text', text: `START:${message}` },
});

setTimeout(() => {
  emit({
    type: 'text',
    timestamp: Date.now(),
    sessionID: sessionId,
    part: { id: 'prt_slow_end', type: 'text', text: 'END' },
  });
}, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 60_000);

// Keep the event loop alive for the whole delay; SIGTERM from the adapter
// terminates the process (that is exactly what "cancel" has to achieve).
