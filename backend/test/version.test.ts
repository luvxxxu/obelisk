import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCommit } from '../src/admin/version';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const dirs: string[] = [];

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-git-'));
  dirs.push(root);
  return root;
}

function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('gitCommit (no git binary, just the files)', () => {
  test('no .git → null', () => {
    expect(gitCommit(checkout())).toBeNull();
  });

  test('a branch as a loose ref', () => {
    const root = checkout();
    write(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    write(join(root, '.git/refs/heads/main'), `${A}\n`);
    expect(gitCommit(root)).toBe(A);
  });

  test('a branch only in packed-refs (a fresh or shallow clone)', () => {
    const root = checkout();
    write(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    write(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/dev\n${A} refs/heads/main\n`);
    expect(gitCommit(root)).toBe(A);
  });

  test('a detached HEAD', () => {
    const root = checkout();
    write(join(root, '.git/HEAD'), `${B}\n`);
    expect(gitCommit(root)).toBe(B);
  });

  test('a worktree: .git is a file, branches live in the main repository', () => {
    const main = checkout();
    write(join(main, '.git/refs/heads/feature'), `${B}\n`);
    write(join(main, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/feature\n');
    write(join(main, '.git/worktrees/wt/commondir'), '../..\n');
    const wt = checkout();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git/worktrees/wt')}\n`);
    expect(gitCommit(wt)).toBe(B);
  });

  test('a ref that names nothing → null', () => {
    const root = checkout();
    write(join(root, '.git/HEAD'), 'ref: refs/heads/gone\n');
    expect(gitCommit(root)).toBeNull();
  });
});
