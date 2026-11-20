import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface BuildInfo {
  commit: string | null;
  builtAt: string | null;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit a checkout is at, read straight from its .git (no git binary): HEAD, then the branch it
 * points to as a loose ref or in packed-refs. Works for worktrees (.git is a file naming the real
 * directory) and shallow clones. Null when there is no repository.
 */
export function gitCommit(root: string): string | null {
  try {
    let gitDir = join(root, '.git');
    if (!existsSync(gitDir)) return null;
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(root, m[1]!.trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return null;
    // A worktree keeps its HEAD; branches live in the main repository ("commondir").
    const dirs = [gitDir];
    const common = join(gitDir, 'commondir');
    if (existsSync(common)) dirs.push(resolve(gitDir, readFileSync(common, 'utf8').trim()));
    for (const dir of dirs) {
      const loose = join(dir, ref);
      if (existsSync(loose)) {
        const sha = readFileSync(loose, 'utf8').trim();
        if (SHA.test(sha)) return sha;
      }
      const packed = join(dir, 'packed-refs');
      if (existsSync(packed)) {
        for (const line of readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(' ');
          if (name === ref && sha && SHA.test(sha)) return sha;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;

/**
 * Which build is running. Docker images carry /app/build-info.json (written while building from the
 * checkout's .git); OBELISK_COMMIT overrides it for other pipelines; a source checkout reads its .git.
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const env = process.env.OBELISK_COMMIT?.trim().toLowerCase();
  if (env && /^[0-9a-f]{7,40}$/.test(env)) {
    cached = { commit: env, builtAt: process.env.OBELISK_BUILT_AT?.trim() || null };
    return cached;
  }
  const repoRoot = resolve(import.meta.dir, '../../..');
  for (const file of [process.env.BUILD_INFO_FILE, '/app/build-info.json', join(repoRoot, 'build-info.json')]) {
    if (!file || !existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
      cached = {
        commit: typeof data.commit === 'string' && SHA.test(data.commit) ? data.commit : null,
        builtAt: typeof data.builtAt === 'string' ? data.builtAt : null,
      };
      if (cached.commit) return cached;
    } catch {}
  }
  cached = { commit: gitCommit(repoRoot), builtAt: null };
  return cached;
}

/** For tests. */
export function resetBuildInfo() {
  cached = null;
}
