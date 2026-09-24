import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  validateCandidate?: (configPath: string) => Promise<void>,
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
  // Reject a divergent remote before validating anything or touching the clone.
  try {
    await git(repoPath, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD');
  } catch {
    throw new Error(`Config clone and origin/${branchName} have diverged; resolve them before syncing.`);
  }
  if (validateCandidate) {
    // Validate the fetched config before merging. A bad remote revision must not
    // be left on disk where a later container restart could load it.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gogglebox-config-'));
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'show', 'FETCH_HEAD:config.json'], {
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      });
      const candidatePath = path.join(tempDir, 'config.json');
      await fs.writeFile(candidatePath, stdout, { mode: 0o600 });
      await validateCandidate(candidatePath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
  await git(repoPath, 'merge', '--ff-only', 'FETCH_HEAD');
  const revision = await git(repoPath, 'rev-parse', 'HEAD');
  return { changed: before !== revision, revision: revision.slice(0, 12) };
}
