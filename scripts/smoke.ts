/**
 * Smoke test for the core RemoteCode chain.
 *
 *   project dir → OpenCode CLI process → streamed output → answer → resume
 *
 * Runs against the REAL installed `opencode` binary in a temporary project
 * directory. Nothing here talks to Telegram, so it isolates the CLI adapter —
 * the riskiest part of the product.
 *
 *   npx tsx scripts/smoke.ts
 *   npx tsx scripts/smoke.ts --keep     # do not delete the temp project
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { OpenCodeAdapter } from '../src/cli/opencode-adapter.js';
import { ModelManager } from '../src/cli/model-manager.js';
import { SessionManager } from '../src/cli/session-manager.js';
import { resolveBinary, runProcess } from '../src/cli/process-runner.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const keep = process.argv.includes('--keep');

  // 1. Binary resolution -----------------------------------------------------
  let binary: string;
  try {
    binary = resolveBinary(config.opencodeBinary);
    record('opencode binary resolves', true, binary);
  } catch (error) {
    record('opencode binary resolves', false, String(error));
    return finish();
  }

  // 2. Version ---------------------------------------------------------------
  const version = await runProcess({ cwd: process.cwd(), args: ['--version'], timeoutMs: 30_000 });
  record(
    'opencode --version',
    version.code === 0,
    `${version.stdout.trim()}${version.stderr.trim() ? ` ${version.stderr.trim()}` : ''}`,
  );

  // 3. --auto flag support ---------------------------------------------------
  const help = await runProcess({ cwd: process.cwd(), args: ['--help'], timeoutMs: 30_000 });
  const supportsAuto = /--auto\b/.test(help.stdout);
  record('CLI supports --auto', supportsAuto, supportsAuto ? 'flag present in --help' : 'flag MISSING');

  // 4. Models list -----------------------------------------------------------
  const modelManager = new ModelManager();
  let models: string[] = [];
  try {
    models = (await modelManager.list()).map((m) => m.id);
    record('opencode models', models.length > 0, `${models.length} models, e.g. ${models[0] ?? '—'}`);
  } catch (error) {
    record('opencode models', false, String(error));
  }

  const preferred =
    models.find((m) => m.includes('mimo')) ?? models[0] ?? null;

  // 5. Fresh project directory ----------------------------------------------
  const projectDir = await mkdtemp(join(tmpdir(), 'remotecode-smoke-'));
  await writeFile(join(projectDir, 'README.md'), '# smoke project\n');
  console.log(`\nproject directory: ${projectDir}\n`);

  const adapter = new OpenCodeAdapter();
  const sessionManager = new SessionManager();

  try {
    // 6. First prompt --------------------------------------------------------
    const first = await adapter.run({
      cwd: projectDir,
      message: 'Reply with exactly the word PONG and nothing else.',
      model: preferred,
      autoApprove: false,
      timeoutMs: 180_000,
    });

    record(
      'first run exits cleanly',
      first.ok && first.exitCode === 0,
      `exit=${first.exitCode} cancelled=${first.cancelled}${first.error ? ` err=${first.error}` : ''}`,
    );
    record('run returns an answer', first.text.trim().length > 0, JSON.stringify(first.text.slice(0, 120)));
    record(
      'run reports a session id',
      typeof first.opencodeSessionId === 'string' && first.opencodeSessionId.startsWith('ses_'),
      first.opencodeSessionId ?? 'null',
    );

    // 7. Multi-line prompt stays ONE prompt ---------------------------------
    const multiline = await adapter.run({
      cwd: projectDir,
      message: 'Line one.\nLine two.\nLine three.\nReply with exactly: MULTILINE_OK',
      sessionId: first.opencodeSessionId,
      model: preferred,
      autoApprove: false,
      timeoutMs: 180_000,
    });

    record(
      'multi-line message is a single prompt',
      multiline.ok && multiline.text.includes('MULTILINE_OK'),
      JSON.stringify(multiline.text.slice(0, 160)),
    );

    // 8. Resume keeps the same session --------------------------------------
    const sameSession =
      multiline.opencodeSessionId !== null && multiline.opencodeSessionId === first.opencodeSessionId;
    record(
      'resume reuses the same OpenCode session',
      sameSession,
      `${first.opencodeSessionId} → ${multiline.opencodeSessionId}`,
    );

    // 9. Context is really preserved ----------------------------------------
    const contextCheck = await adapter.run({
      cwd: projectDir,
      message: 'What word did I ask you to reply with on your very first answer in this session? Reply with just that word.',
      sessionId: first.opencodeSessionId,
      model: preferred,
      autoApprove: false,
      timeoutMs: 180_000,
    });
    record(
      'conversation context survives resume',
      contextCheck.ok && /PONG/i.test(contextCheck.text),
      JSON.stringify(contextCheck.text.slice(0, 160)),
    );

    // 10. Model switch on the SAME session ----------------------------------
    const otherModel = models.find((m) => m !== preferred) ?? null;
    if (otherModel && first.opencodeSessionId) {
      const switched = await adapter.run({
        cwd: projectDir,
        message: `Reply with exactly: SWITCHED_TO_${otherModel.split('/').pop()?.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? 'X'}`,
        sessionId: first.opencodeSessionId,
        model: otherModel,
        autoApprove: false,
        timeoutMs: 180_000,
      });
      record(
        'model switch keeps the session',
        switched.ok && switched.opencodeSessionId === first.opencodeSessionId,
        `${otherModel} → ${switched.opencodeSessionId ?? 'null'}`,
      );
      record('model switch produces output', switched.text.trim().length > 0, JSON.stringify(switched.text.slice(0, 160)));
    } else {
      record('model switch keeps the session', false, 'only one model available — skipped');
    }

    // 11. Session is visible to the official CLI ----------------------------
    const remote = await sessionManager.listRemote(projectDir);
    const listed = remote.some((s) => s.id === first.opencodeSessionId);
    record('session appears in `opencode session list`', listed, `${remote.length} sessions in project`);

    // 12. Export works (recovery path) --------------------------------------
    if (first.opencodeSessionId) {
      const exported = await sessionManager.exportRemote(projectDir, first.opencodeSessionId);
      record(
        '`session export` returns history',
        exported !== null && Array.isArray(exported.messages) && exported.messages.length > 0,
        exported ? `${exported.messages.length} messages` : 'null',
      );

      const exists = await sessionManager.sessionExists(projectDir, first.opencodeSessionId);
      record('sessionExists agrees with the CLI', exists === listed, `exists=${exists} listed=${listed}`);
    }

    // 13. Long output is not truncated --------------------------------------
    // NB: a prompt demanding an EXACT character count makes the model hang
    // (verified: step_start then silence for 300s) — ask for natural long-form
    // text instead and check the adapter preserves a comfortably long answer.
    const long = await adapter.run({
      cwd: projectDir,
      message:
        'Reply with the single word LONG, then write a detailed essay about the history of programming languages, at least 800 characters.',
      sessionId: first.opencodeSessionId,
      model: preferred,
      autoApprove: false,
      timeoutMs: 240_000,
    });
    record(
      'long answer is not truncated by the adapter',
      long.ok && long.text.length >= 500,
      `${long.text.length} chars received`,
    );

    // 14. Cancellation -------------------------------------------------------
    const controller = new AbortController();
    const cancelledRun = adapter.run({
      cwd: projectDir,
      message: 'Write a very long detailed essay about the history of compilers, at least 4000 words.',
      sessionId: first.opencodeSessionId,
      model: preferred,
      autoApprove: false,
      timeoutMs: 240_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 3000);
    const cancelled = await cancelledRun;
    record(
      'abort signal cancels the run',
      cancelled.cancelled || !cancelled.ok,
      `cancelled=${cancelled.cancelled} exit=${cancelled.exitCode}`,
    );
  } catch (error) {
    record('smoke sequence completed', false, error instanceof Error ? String(error.stack) : String(error));
  } finally {
    if (!keep) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
      console.log(`\ncleaned up ${projectDir}`);
    } else {
      console.log(`\nkept ${projectDir}`);
    }
  }

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
