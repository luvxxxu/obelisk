/**
 * Prints the build's version as JSON: the checkout's commit (read from its .git, no git binary needed)
 * and the build time. The backend Dockerfile writes it to /app/build-info.json for 서버 관리's update check.
 *   bun backend/scripts/build-info.ts [checkout root, default: cwd]
 */
import { gitCommit } from '../src/admin/version';

const root = process.argv[2] ?? process.cwd();
console.log(JSON.stringify({ commit: process.env.OBELISK_COMMIT?.trim() || gitCommit(root), builtAt: new Date().toISOString() }));
