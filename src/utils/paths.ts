/**
 * Path security primitives for RemoteCode.
 *
 * Project paths are supplied by Telegram users, so every path that reaches
 * the filesystem must pass through these helpers first:
 *
 * - `normalizeProjectPath` validates and normalizes a user-supplied path.
 * - `assertPathInside` enforces containment within an allowed root using a
 *   separator-aware prefix check (`/a/bc` must NOT count as inside `/a/b`).
 * - `assertNoSymlinkEscape` re-checks containment on the *real* paths so a
 *   symlink planted inside the root cannot redirect writes outside of it.
 */

import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Thrown when a path fails a security check. */
export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/** Characters that are never allowed in a project path. */
const FORBIDDEN_CHARS = /[<>"|^]/;
/** C0 control characters plus DEL (includes NUL, tab and newline). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Rejects NUL bytes, control characters and shell/redirect metacharacters. */
function assertSafePathChars(value: string, label: string): void {
  if (value.includes('\u0000')) {
    throw new PathSecurityError(`${label} must not contain NUL bytes`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new PathSecurityError(`${label} must not contain control characters`);
  }
  const forbidden = FORBIDDEN_CHARS.exec(value);
  if (forbidden !== null) {
    throw new PathSecurityError(`${label} contains forbidden character ${JSON.stringify(forbidden[0])}`);
  }
}

/**
 * Validates and normalizes a user-supplied project path.
 *
 * Trims whitespace, strips one layer of surrounding quotes, rejects empty
 * input, NUL bytes, control characters and `< > " | ^`, then resolves to an
 * absolute, platform-normalized path (forward slashes become the platform
 * separator via `path.normalize`).
 */
export function normalizeProjectPath(input: string): string {
  let candidate = input.trim();

  if (candidate.length >= 2) {
    const first = candidate.charAt(0);
    const last = candidate.charAt(candidate.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      candidate = candidate.slice(1, -1).trim();
    }
  }

  if (candidate === '') {
    throw new PathSecurityError('Project path must not be empty');
  }
  assertSafePathChars(candidate, 'Project path');

  return path.normalize(path.resolve(candidate));
}

/** Case-folds paths for comparison on Windows (its default FS is case-insensitive). */
function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Asserts that `candidate` resolves to a location at or inside `root`.
 * Returns the resolved candidate path.
 *
 * Uses a separator-aware prefix check so `/a/bc` is rejected for root `/a/b`.
 */
export function assertPathInside(root: string, candidate: string): string {
  assertSafePathChars(root, 'Root path');
  assertSafePathChars(candidate, 'Candidate path');

  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);

  const rootCmp = comparable(resolvedRoot);
  const candidateCmp = comparable(resolvedCandidate);
  const rootWithSep = rootCmp.endsWith(path.sep) ? rootCmp : rootCmp + path.sep;

  const inside = candidateCmp === rootCmp || candidateCmp.startsWith(rootWithSep);
  if (!inside) {
    throw new PathSecurityError(`Path escapes the allowed root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

/** Creates a directory (and parents) if it does not exist. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Returns true when `p` exists and is a directory; false on any stat failure. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    const info = await stat(p);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the real path of `target`, tolerating not-yet-existing trailing
 * segments by resolving the deepest existing ancestor instead. Fails closed:
 * if the filesystem cannot be resolved, a PathSecurityError is thrown.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      if (!isEnoent(error) || path.dirname(current) === current) {
        throw new PathSecurityError(`Unable to resolve the real path of "${resolved}": ${describeError(error)}`);
      }
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

/**
 * Verifies that `target` (after resolving every symlink) still lies inside
 * `root`. Used before creating project folders so a symlink planted inside
 * the projects root cannot redirect writes outside of it.
 */
export async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const realRoot = await realpathAllowingMissing(root);
  const realTarget = await realpathAllowingMissing(target);
  assertPathInside(realRoot, realTarget);
}
