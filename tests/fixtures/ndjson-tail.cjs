/**
 * Fixture that emits its LAST event without a trailing newline.
 *
 * The adapter must flush the unterminated NDJSON tail right before building the
 * RunResult, otherwise the closing text part would be lost.
 */
'use strict';

const args = process.argv.slice(2);
const message = args.length > 0 ? args[args.length - 1] : '';
const sessionId = 'ses_fixture_tail';

function emit(event, newline = true) {
  process.stdout.write(JSON.stringify(event) + (newline ? '\n' : ''));
}

emit({ type: 'step_start', timestamp: Date.now(), sessionID: sessionId, part: { type: 'step-start' } });
emit(
  {
    type: 'text',
    timestamp: Date.now(),
    sessionID: sessionId,
    part: { id: 'prt_tail', type: 'text', text: `TAIL:${message}` },
  },
  false, // ← no trailing newline on purpose
);
