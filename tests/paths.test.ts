import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PathSecurityError,
  assertNoSymlinkEscape,
  assertPathInside,
  ensureDir,
  isDirectory,
  normalizeProjectPath,
} from '../src/utils/paths.js';

describe('normalizeProjectPath', () => {
  it('trims, resolves and normalizes a relative path', () => {
    const result = normalizeProjectPath('  my-app  ');
    expect(result).toBe(path.normalize(path.resolve('my-app')));
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('converts forward slashes to platform separators', () => {
    const result = normalizeProjectPath('some/nested/dir');
    expect(result).toBe(path.normalize(path.resolve('some', 'nested', 'dir')));
    expect(result.includes('/')).toBe(process.platform !== 'win32');
  });

  it('strips one layer of surrounding quotes', () => {
    expect(normalizeProjectPath('"my-app"')).toBe(path.resolve('my-app'));
    expect(normalizeProjectPath("'my-app'")).toBe(path.resolve('my-app'));
    expect(normalizeProjectPath('"C:\\projects\\app"')).toBe(path.normalize(path.resolve('C:\\projects\\app')));
  });

  it('rejects empty input', () => {
    expect(() => normalizeProjectPath('')).toThrow(PathSecurityError);
    expect(() => normalizeProjectPath('   ')).toThrow(PathSecurityError);
    expect(() => normalizeProjectPath('""')).toThrow(PathSecurityError);
  });

  it('rejects embedded NUL bytes', () => {
    expect(() => normalizeProjectPath('bad\u0000name')).toThrow(PathSecurityError);
    expect(() => normalizeProjectPath('bad\u0000name')).toThrow(/NUL/);
  });

  it('rejects shell/redirect metacharacters', () => {
    for (const ch of ['<', '>', '"', '|', '^']) {
      expect(() => normalizeProjectPath(`bad${ch}name`)).toThrow(PathSecurityError);
    }
  });

  it('rejects control characters', () => {
    expect(() => normalizeProjectPath('bad\nname')).toThrow(PathSecurityError);
    expect(() => normalizeProjectPath('bad\tname')).toThrow(PathSecurityError);
    expect(() => normalizeProjectPath('bad\u0007name')).toThrow(PathSecurityError);
  });
});

describe('assertPathInside', () => {
  const root = path.resolve(path.sep === '\\' ? 'C:/a/b' : '/a/b');

  it('accepts a path directly inside the root', () => {
    const inside = assertPathInside(root, path.join(root, 'child'));
    expect(inside).toBe(path.join(root, 'child'));
  });

  it('accepts the root itself', () => {
    expect(assertPathInside(root, root)).toBe(root);
  });

  it('rejects a sibling directory sharing the root as a string prefix', () => {
    // /a/bc startsWith /a/b, but it is NOT inside /a/b.
    const sibling = root + 'c';
    expect(() => assertPathInside(root, sibling)).toThrow(PathSecurityError);
  });

  it('rejects traversal that escapes the root', () => {
    expect(() => assertPathInside(root, path.join(root, '..', '..', 'etc'))).toThrow(PathSecurityError);
    expect(() => assertPathInside(root, path.join(root, 'sub', '..', '..', '..', 'etc'))).toThrow(PathSecurityError);
  });

  it('rejects relative traversal resolved against the cwd', () => {
    expect(() => assertPathInside(root, '../../etc')).toThrow(PathSecurityError);
    expect(() => assertPathInside(root, 'C:\\..\\..')).toThrow(PathSecurityError);
  });

  it('rejects a parent directory', () => {
    expect(() => assertPathInside(root, path.dirname(root))).toThrow(PathSecurityError);
  });

  it('rejects candidates containing NUL bytes', () => {
    expect(() => assertPathInside(root, path.join(root, 'a\u0000b'))).toThrow(PathSecurityError);
  });
});

describe('ensureDir / isDirectory', () => {
  it('creates missing directories recursively', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rc-dirs-'));
    try {
      const nested = path.join(base, 'a', 'b', 'c');
      await ensureDir(nested);
      expect(await isDirectory(nested)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reports false for missing paths', async () => {
    expect(await isDirectory(path.join(os.tmpdir(), 'rc-definitely-missing-12345'))).toBe(false);
  });
});

describe('assertNoSymlinkEscape', () => {
  it('accepts real directories and not-yet-created paths inside the root', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rc-link-'));
    try {
      const root = path.join(base, 'root');
      await mkdir(root, { recursive: true });
      await mkdir(path.join(root, 'real'), { recursive: true });

      await expect(assertNoSymlinkEscape(root, path.join(root, 'real'))).resolves.toBeUndefined();
      // Target does not exist yet: creating a project folder must not fail.
      await expect(assertNoSymlinkEscape(root, path.join(root, 'new-project'))).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects a symlink inside the root that points outside of it', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rc-link-'));
    try {
      const root = path.join(base, 'root');
      const outside = path.join(base, 'outside');
      await mkdir(root, { recursive: true });
      await mkdir(outside, { recursive: true });
      const link = path.join(root, 'escape');
      await symlink(outside, link, 'junction');

      await expect(assertNoSymlinkEscape(root, link)).rejects.toThrow(PathSecurityError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
