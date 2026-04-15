/**
 * Integration tests for the git-state commit/push flow.
 *
 * These tests exercise the git infrastructure that the deployer subprocess
 * relies on when committing and pushing tentacle changes. They use real git
 * binaries, a local bare repo as the "remote", and the actual pre-commit hook
 * from kraken-hooks/pre-commit.
 *
 * What these tests verify:
 * 1. Changes committed in the working clone appear in the bare remote.
 * 2. Multiple sequential commits all reach the remote.
 * 3. The pre-commit hook auto-bumps workflow.yaml version on commit.
 * 4. Push failures are surfaced cleanly without corrupting local git state.
 * 5. Concurrent commits don't corrupt the repo (git's file locks serialize them).
 *
 * What these tests do NOT verify:
 * - tntc deploy (tested via unit mocks in deploy.test.ts)
 * - deployments-db CRUD (tested in deployments-db.test.ts)
 * - The deployer agent logic (it uses bash; we test the infrastructure it runs on)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory, returning trimmed stdout.
 * Throws if the command exits non-zero.
 */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Create a temporary bare git repository (simulates the remote).
 * Returns its absolute path.
 *
 * The bare repo is explicitly initialised with `main` as the default branch
 * so tests are not sensitive to the global `init.defaultBranch` setting.
 */
function createBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-bare-'));
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir]);
  return dir;
}

/**
 * Clone a bare repo into a working directory and configure it for Kraken use:
 *  - Sets user.name / user.email
 *  - Points core.hooksPath at the real kraken-hooks directory
 *
 * Returns the absolute path of the working clone.
 *
 * Note: we create an initial commit via a throwaway clone first, because git
 * will refuse to clone a completely empty bare repo.
 */
function cloneWorkingRepo(bareRepoPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-work-'));

  // Seed the bare repo with one commit via a throwaway clone.
  const initDir = mkdtempSync(join(tmpdir(), 'kraken-init-'));
  execFileSync('git', ['clone', bareRepoPath, initDir]);
  execFileSync('git', ['config', 'user.email', 'kraken@tentacular.dev'], {
    cwd: initDir,
  });
  execFileSync('git', ['config', 'user.name', 'The Kraken'], { cwd: initDir });
  writeFileSync(join(initDir, '.gitkeep'), '');
  execFileSync('git', ['add', '.'], { cwd: initDir });
  execFileSync('git', ['commit', '-m', 'chore: init', '--no-verify'], {
    cwd: initDir,
  });
  // Push to main explicitly; the branch in initDir is already named main
  // because the bare repo was initialised with --initial-branch=main.
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: initDir });
  rmSync(initDir, { recursive: true, force: true });

  // Clone the seeded bare repo.
  execFileSync('git', ['clone', bareRepoPath, dir]);
  execFileSync('git', ['config', 'user.email', 'kraken@tentacular.dev'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'user.name', 'The Kraken'], { cwd: dir });

  // Wire the real pre-commit hook so git commit actually fires it.
  const hooksDir = resolve(process.cwd(), 'kraken-hooks');
  execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: dir });

  return dir;
}

/**
 * Write a workflow.yaml and a main.ts into enclaves/<enclave>/<tentacle>/
 * inside the given working directory.
 */
function writeTentacleFiles(
  workDir: string,
  enclave: string,
  tentacle: string,
  version = 1,
): void {
  const tentacleDir = join(workDir, 'enclaves', enclave, tentacle);
  mkdirSync(tentacleDir, { recursive: true });
  writeFileSync(
    join(tentacleDir, 'workflow.yaml'),
    `name: ${tentacle}\nversion: ${version}\n`,
  );
  writeFileSync(
    join(tentacleDir, 'main.ts'),
    `// ${tentacle} v${version}\nexport const name = '${tentacle}';\n`,
  );
}

/**
 * Count the commits reachable from HEAD in the given repo.
 */
function countCommits(repoDir: string): number {
  const out = execSync('git rev-list --count HEAD', {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
  return parseInt(out, 10);
}

/**
 * Return the log of commit subjects (newest first) from the given repo.
 */
function commitSubjects(repoDir: string, n = 10): string[] {
  const out = execSync(`git log -${n} --format=%s`, {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
  return out ? out.split('\n') : [];
}

/**
 * Return the HEAD SHA of the given repo.
 */
function headSha(repoDir: string): string {
  return git('rev-parse HEAD', repoDir);
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let bareRepo: string;
let workRepo: string;
let dirsToClean: string[];

beforeEach(() => {
  dirsToClean = [];
  bareRepo = createBareRepo();
  workRepo = cloneWorkingRepo(bareRepo);
  dirsToClean.push(bareRepo, workRepo);
});

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('git-state flow', () => {
  /**
   * Test 1: Deploy writes to git-state and commits.
   *
   * Simulates the deployer agent writing a tentacle and running git add/commit/push.
   * Verifies:
   * - The commit exists locally
   * - The bare repo (remote) has the new commit
   */
  it('commit reaches the bare remote after git push', () => {
    writeTentacleFiles(workRepo, 'test-enclave', 'hello-world');

    git('add enclaves/test-enclave/hello-world', workRepo);
    git('commit -m "feat(tentacle): deploy hello-world"', workRepo);
    git('push origin main', workRepo);

    // The bare repo should now have the new commit.
    const bareCommits = countCommits(bareRepo);
    const workCommits = countCommits(workRepo);

    // Both repos should have the same number of commits (init + deploy).
    expect(bareCommits).toBe(workCommits);
    expect(bareCommits).toBeGreaterThanOrEqual(2); // init + our commit

    // The subjects should include our commit message.
    const subjects = commitSubjects(bareRepo);
    expect(subjects[0]).toBe('feat(tentacle): deploy hello-world');
  });

  /**
   * Test 2: Multiple deploys in sequence.
   *
   * Deploys two tentacles one after the other, verifying:
   * - Both commits appear in the log
   * - Both files exist in the working tree
   * - The bare repo has both commits
   */
  it('multiple sequential deploys all reach the remote', () => {
    // Deploy tentacle A
    writeTentacleFiles(workRepo, 'staging', 'data-ingestion');
    git('add enclaves/staging/data-ingestion', workRepo);
    git('commit -m "feat(tentacle): deploy data-ingestion"', workRepo);
    git('push origin main', workRepo);

    // Deploy tentacle B
    writeTentacleFiles(workRepo, 'staging', 'notification-sender');
    git('add enclaves/staging/notification-sender', workRepo);
    git('commit -m "feat(tentacle): deploy notification-sender"', workRepo);
    git('push origin main', workRepo);

    // Both files should exist in the working tree.
    const fileA = join(
      workRepo,
      'enclaves',
      'staging',
      'data-ingestion',
      'workflow.yaml',
    );
    const fileB = join(
      workRepo,
      'enclaves',
      'staging',
      'notification-sender',
      'workflow.yaml',
    );
    expect(readFileSync(fileA, 'utf8')).toContain('name: data-ingestion');
    expect(readFileSync(fileB, 'utf8')).toContain('name: notification-sender');

    // Both commits should be in the bare repo log.
    const subjects = commitSubjects(bareRepo, 5);
    expect(subjects).toContain('feat(tentacle): deploy notification-sender');
    expect(subjects).toContain('feat(tentacle): deploy data-ingestion');

    // The bare repo HEAD should match the working repo HEAD.
    expect(headSha(bareRepo)).toBe(headSha(workRepo));
  });

  /**
   * Test 3: Pre-commit hook fires and bumps version.
   *
   * Sets up a tentacle at version 1, then makes a second change without
   * manually incrementing the version. The pre-commit hook should bump it
   * to version 2 automatically.
   */
  it('pre-commit hook bumps workflow.yaml version on commit', () => {
    const workflowPath = join(
      workRepo,
      'enclaves',
      'prod',
      'batch-processor',
      'workflow.yaml',
    );
    const mainTsPath = join(
      workRepo,
      'enclaves',
      'prod',
      'batch-processor',
      'main.ts',
    );

    // First deploy: establishes version 1 in HEAD.
    writeTentacleFiles(workRepo, 'prod', 'batch-processor', 1);
    git('add enclaves/prod/batch-processor', workRepo);
    // Use --no-verify for the first commit so version 1 is established as the
    // baseline in HEAD without the hook bumping it.
    git('commit -m "feat(tentacle): initial deploy batch-processor" --no-verify', workRepo);

    // Second deploy: modify main.ts but leave workflow.yaml at version 1.
    // The hook should detect staged_version (1) <= head_version (1) and bump.
    writeFileSync(mainTsPath, "// batch-processor updated\nexport const v = 2;\n");
    git('add enclaves/prod/batch-processor/main.ts', workRepo);
    git('commit -m "feat(tentacle): update batch-processor"', workRepo);

    // The hook should have bumped workflow.yaml to version 2.
    const content = readFileSync(workflowPath, 'utf8');
    expect(content).toContain('version: 2');

    // Push and verify the bare repo also sees version 2.
    git('push origin main', workRepo);
    expect(headSha(bareRepo)).toBe(headSha(workRepo));
  });

  /**
   * Test 4: Push failure handling.
   *
   * Points the remote to an invalid URL, then attempts a commit + push.
   * Verifies:
   * - The push failure throws (surfaced to the caller)
   * - The local commit is intact (git is not corrupted)
   * - A subsequent push to a valid remote succeeds
   */
  it('push failure surfaces the error without corrupting local state', () => {
    writeTentacleFiles(workRepo, 'dev', 'health-check');
    git('add enclaves/dev/health-check', workRepo);
    git('commit -m "feat(tentacle): deploy health-check" --no-verify', workRepo);

    // Remember the local HEAD SHA before attempting the bad push.
    const localSha = headSha(workRepo);

    // Point origin to an invalid URL to simulate push failure.
    git('remote set-url origin file:///nonexistent/path/bare.git', workRepo);

    // Push should fail.
    expect(() => {
      execSync('git push origin main', {
        cwd: workRepo,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    }).toThrow();

    // Local state must still be intact: HEAD SHA unchanged.
    expect(headSha(workRepo)).toBe(localSha);

    // The commit should still be in the local log.
    const subjects = commitSubjects(workRepo, 5);
    expect(subjects[0]).toBe('feat(tentacle): deploy health-check');

    // Restore the valid remote and push again — should succeed.
    git(`remote set-url origin ${bareRepo}`, workRepo);
    git('push origin main', workRepo);
    expect(headSha(bareRepo)).toBe(localSha);
  });

  /**
   * Test 5: Concurrent commits don't corrupt the repo.
   *
   * Starts two git commits concurrently (via Promise.all + execFile).
   * Git's index lock serializes them. Verifies both commits appear in the log.
   *
   * Note: concurrent git commits to the same working tree will typically
   * fail with an index lock error. The test accepts that one may fail, but
   * verifies the repo is not corrupted and the successful commit is present.
   * A real deployer should serialize commits (one at a time per enclave).
   */
  it('concurrent commit attempts leave the repo in a consistent state', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Write both tentacle directories first (not concurrent).
    writeTentacleFiles(workRepo, 'concurrent', 'worker-a');
    writeTentacleFiles(workRepo, 'concurrent', 'worker-b');

    // Stage both tentacles.
    git('add enclaves/concurrent', workRepo);

    // Attempt two git commits concurrently. One should win; the other
    // will likely fail due to the git index lock.
    const commitA = execFileAsync(
      'git',
      ['commit', '-m', 'feat(tentacle): worker-a', '--no-verify'],
      { cwd: workRepo },
    ).catch((e: Error) => ({ error: e }));

    const commitB = execFileAsync(
      'git',
      ['commit', '-m', 'feat(tentacle): worker-b', '--no-verify'],
      { cwd: workRepo },
    ).catch((e: Error) => ({ error: e }));

    const results = await Promise.all([commitA, commitB]);

    // At least one commit must have succeeded.
    const successes = results.filter((r) => !('error' in r));
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // The repo must not be in a detached HEAD or broken state.
    const branch = git('rev-parse --abbrev-ref HEAD', workRepo);
    expect(branch).toBe('main');

    // At least one commit message should appear in the log.
    const subjects = commitSubjects(workRepo, 10);
    const hasWorkerCommit =
      subjects.includes('feat(tentacle): worker-a') ||
      subjects.includes('feat(tentacle): worker-b');
    expect(hasWorkerCommit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entrypoint gap coverage
// ---------------------------------------------------------------------------

describe('entrypoint git-state setup gaps', () => {
  /**
   * The entrypoint.sh sets core.hooksPath to /app/kraken-hooks.
   * This test verifies that the hooks path config is required for
   * version bumping to work — without it, the hook does not fire.
   *
   * This guards against a regression where a new container image forgets
   * to set core.hooksPath during startup.
   */
  it('version is NOT bumped when core.hooksPath is not set (hooks disabled)', () => {
    // Create a repo WITHOUT the hooks path configured.
    const bareDir = createBareRepo();
    dirsToClean.push(bareDir);

    const initDir = mkdtempSync(join(tmpdir(), 'kraken-nohook-init-'));
    dirsToClean.push(initDir);
    execFileSync('git', ['clone', bareDir, initDir]);
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: initDir,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: initDir });
    writeFileSync(join(initDir, '.gitkeep'), '');
    execFileSync('git', ['add', '.'], { cwd: initDir });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], {
      cwd: initDir,
    });
    execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: initDir });
    rmSync(initDir, { recursive: true, force: true });

    const noHookRepo = mkdtempSync(join(tmpdir(), 'kraken-nohook-'));
    dirsToClean.push(noHookRepo);
    execFileSync('git', ['clone', bareDir, noHookRepo]);
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: noHookRepo,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: noHookRepo });
    // Intentionally do NOT set core.hooksPath.

    const tentacleDir = join(noHookRepo, 'enclaves', 'dev', 'my-worker');
    mkdirSync(tentacleDir, { recursive: true });
    writeFileSync(
      join(tentacleDir, 'workflow.yaml'),
      'name: my-worker\nversion: 1\n',
    );
    writeFileSync(join(tentacleDir, 'main.ts'), 'export const v = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: noHookRepo });
    execFileSync('git', ['commit', '-m', 'init tentacle', '--no-verify'], {
      cwd: noHookRepo,
    });

    // Now stage a change without hooks set — version should NOT be bumped.
    writeFileSync(join(tentacleDir, 'main.ts'), 'export const v = 2;\n');
    execFileSync('git', ['add', 'enclaves/dev/my-worker/main.ts'], {
      cwd: noHookRepo,
    });
    execFileSync('git', ['commit', '-m', 'update without hooks'], {
      cwd: noHookRepo,
    });

    const content = readFileSync(
      join(tentacleDir, 'workflow.yaml'),
      'utf8',
    );
    // Without the hook, version stays at 1 — demonstrating the hook is
    // critical and must be configured via entrypoint.sh.
    expect(content).toContain('version: 1');
  });

  /**
   * The entrypoint.sh runs `git pull --ff-only` if the git-state dir
   * already exists. This test verifies that a fast-forward pull from the
   * remote succeeds and the local repo advances to the remote HEAD.
   */
  it('git pull --ff-only advances the working clone to remote HEAD', () => {
    // Simulate another deployer pushing a commit to the bare repo directly
    // (represents another Kraken pod or a human pushing from their machine).
    const otherClone = mkdtempSync(join(tmpdir(), 'kraken-other-'));
    dirsToClean.push(otherClone);
    execFileSync('git', ['clone', bareRepo, otherClone]);
    execFileSync('git', ['config', 'user.email', 'other@test.com'], {
      cwd: otherClone,
    });
    execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });

    writeTentacleFiles(otherClone, 'shared', 'remote-tentacle');
    git('add enclaves/shared/remote-tentacle', otherClone);
    git('commit -m "feat(tentacle): remote-tentacle from other pod" --no-verify', otherClone);
    git('push origin main', otherClone);

    const remoteSha = headSha(otherClone);

    // The workRepo is behind — simulate the entrypoint.sh pull.
    execSync('git pull --ff-only origin main', {
      cwd: workRepo,
      encoding: 'utf8',
    });

    // After pull, workRepo should be at the same SHA as the remote push.
    expect(headSha(workRepo)).toBe(remoteSha);
  });
});
