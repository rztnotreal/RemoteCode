/**
 * Fixture process for adapter/process-manager tests.
 *
 * Behaves like `opencode run --format json`: it prints NDJSON events and exits
 * with code 0, but without touching the network, the model or the filesystem.
 *
 * The adapter passes the prompt as the LAST argv element (single argument, new
 * lines preserved), so echoing it back proves the prompt was not split.
 *
 *   node ndjson-ok.cjs [-s <session>] [-m <model>] [--auto] <prompt>
 */
'use strict';

const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

const message = args.length > 0 ? args[args.length - 1] : '';
const sessionId =
  argValue('-s') ||
  argValue('--session') ||
  `ses_fixture_${Math.random().toString(36).slice(2, 10)}`;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

emit({ type: 'step_start', timestamp: Date.now(), sessionID: sessionId, part: { type: 'step-start' } });

emit({
  type: 'tool_use',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: {
    id: 'prt_tool_1',
    type: 'tool',
    tool: 'write',
    state: { input: { file_path: 'src/index.ts' } },
  },
});

emit({
  type: 'text',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: { id: 'prt_text_1', type: 'text', text: `ECHO:${message}` },
});

emit({
  type: 'text',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: { id: 'prt_text_2', type: 'text', text: `MODEL:${argValue('-m') || 'default'}` },
});

emit({
  type: 'text',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: { id: 'prt_text_3', type: 'text', text: `AUTO:${args.includes('--auto') ? 'yes' : 'no'}` },
});

emit({
  type: 'step_finish',
  timestamp: Date.now(),
  sessionID: sessionId,
  part: { type: 'step-finish', reason: 'stop' },
});

// Natural exit (no process.exit): stdout is fully flushed before the code 0.
