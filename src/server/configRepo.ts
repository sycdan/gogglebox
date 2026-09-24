import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  return stdout.trim();
}

// Config is edited in another clone and pushed to the bare remote. The app only
// pulls fast-forwards; a dirty or diverged production clone needs a person to
// resolve it instead of silently losing a local edit.
export async function syncConfigRepo(
  repoPath: string,
  branchName = 'main',
): Promise<{ changed: boolean; revision: string }> {
  const currentBranch = await git(repoPath, 'symbolic-ref', '--short', 'HEAD');
  if (currentBranch !== branchName) {
    throw new Error(`Config clone is on ${currentBranch}; switch to ${branchName} before syncing.`);
  }

  const status = await git(repoPath, 'status', '--porcelain', '--untracked-files=all');
  if (status) {
    throw new Error('Config clone has local changes; commit or remove them before syncing.');
  }

  const before = await git(repoPath, 'rev-parse', 'HEAD');
  await git(repoPath, 'fetch', '--no-tags', 'origin', branchName);
  await git(repoPath, 'merge', '--ff-only', 'FETCH_HEAD');
  const revision = await git(repoPath, 'rev-parse', 'HEAD');
  return { changed: before !== revision, revision: revision.slice(0, 12) };
}
