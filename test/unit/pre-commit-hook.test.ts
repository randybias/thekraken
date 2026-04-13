/**
 * Unit test for kraken-hooks/pre-commit.
 *
 * Creates a temporary git repository fixture with a mock enclave/tentacle
 * structure, stages a change, runs the hook, and asserts the version is
 * incremented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOOK_PATH = resolve(process.cwd(), 'kraken-hooks/pre-commit');

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' }).trim();
}

let tmpRepo: string;

beforeEach(() => {
  // Create a temp git repo
  tmpRepo = mkdtempSync(join(tmpdir(), 'kraken-hook-test-'));
  git('init', tmpRepo);
  git('config user.email "test@example.com"', tmpRepo);
  git('config user.name "Test"', tmpRepo);
  git(
    `config core.hooksPath "${resolve(process.cwd(), 'kraken-hooks')}"`,
    tmpRepo,
  );

  // Create initial enclave structure
  const tentacleDir = join(
    tmpRepo,
    'enclaves',
    'marketing',
    'sentiment-analyzer',
  );
  mkdirSync(tentacleDir, { recursive: true });

  writeFileSync(
    join(tentacleDir, 'workflow.yaml'),
    'name: sentiment-analyzer\nversion: 3\n',
  );
  writeFileSync(join(tentacleDir, 'main.ts'), 'export const v = 1;\n');

  git('add .', tmpRepo);
  git('commit -m "Initial commit" --no-verify', tmpRepo);
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe('pre-commit hook', () => {
  it('bumps version when a tentacle source file is staged', () => {
    const mainTs = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'main.ts',
    );
    writeFileSync(mainTs, 'export const v = 2;\n');
    git('add enclaves/marketing/sentiment-analyzer/main.ts', tmpRepo);

    // Run the hook manually
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });

    const workflowPath = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );
    const content = readFileSync(workflowPath, 'utf8');
    expect(content).toContain('version: 4');
  });

  it('does NOT bump version when only CONTEXT.md is staged', () => {
    const contextMd = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'CONTEXT.md',
    );
    writeFileSync(contextMd, '# Context\nUpdated docs.\n');
    git('add enclaves/marketing/sentiment-analyzer/CONTEXT.md', tmpRepo);

    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });

    const workflowPath = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );
    const content = readFileSync(workflowPath, 'utf8');
    // Version should remain 3
    expect(content).toContain('version: 3');
  });

  it('exits 0 when no files under enclaves/ are staged', () => {
    // Stage a file outside enclaves/
    writeFileSync(join(tmpRepo, 'README.md'), 'hello\n');
    git('add README.md', tmpRepo);

    // Should succeed without error
    expect(() => {
      execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    }).not.toThrow();
  });

  it('bumps only the affected tentacle, not others', () => {
    // Create a second tentacle
    const tentacleB = join(tmpRepo, 'enclaves', 'engineering', 'api-gateway');
    mkdirSync(tentacleB, { recursive: true });
    writeFileSync(
      join(tentacleB, 'workflow.yaml'),
      'name: api-gateway\nversion: 1\n',
    );
    writeFileSync(join(tentacleB, 'main.ts'), 'export const x = 1;\n');
    git('add .', tmpRepo);
    git('commit -m "Add engineering tentacle" --no-verify', tmpRepo);

    // Stage a change in marketing only
    const mainTs = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'main.ts',
    );
    writeFileSync(mainTs, 'export const v = 3;\n');
    git('add enclaves/marketing/sentiment-analyzer/main.ts', tmpRepo);

    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });

    const marketingWorkflow = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );
    const engineeringWorkflow = join(
      tmpRepo,
      'enclaves',
      'engineering',
      'api-gateway',
      'workflow.yaml',
    );

    expect(readFileSync(marketingWorkflow, 'utf8')).toContain('version: 4');
    expect(readFileSync(engineeringWorkflow, 'utf8')).toContain('version: 1');
  });

  // Codex review T22 caught: hook was not idempotent across retried commits.

  it('does not re-bump when the hook is run twice on the same staged set', () => {
    const mainTs = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'main.ts',
    );
    const workflowFile = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );

    // First hook run: user staged main.ts, hook bumps v3 -> v4.
    writeFileSync(mainTs, 'export const v = 2;\n');
    git('add enclaves/marketing/sentiment-analyzer/main.ts', tmpRepo);
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    expect(readFileSync(workflowFile, 'utf8')).toContain('version: 4');

    // Simulate aborted commit: workflow.yaml is now staged at v4, main.ts
    // also still staged. User retries `git commit`. Hook should NOT bump
    // again because v4 (staged) > v3 (HEAD).
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    expect(readFileSync(workflowFile, 'utf8')).toContain('version: 4');

    // Run a third time for good measure
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    expect(readFileSync(workflowFile, 'utf8')).toContain('version: 4');
  });

  it('respects a manual version bump (does not double-bump)', () => {
    const workflowFile = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );

    // User manually bumps version from 3 -> 5 (skipping 4 entirely) and
    // stages the workflow.yaml change. Hook should leave it alone because
    // staged (5) > HEAD (3).
    writeFileSync(workflowFile, 'name: sentiment-analyzer\nversion: 5\n');
    git('add enclaves/marketing/sentiment-analyzer/workflow.yaml', tmpRepo);
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    expect(readFileSync(workflowFile, 'utf8')).toContain('version: 5');
  });

  it('uses HEAD+1 not staged+1 to compute the new version', () => {
    // If a user somehow staged a workflow.yaml with version BELOW HEAD
    // (e.g., a botched merge), the hook should bring it back to HEAD+1
    // rather than bumping the wrong value.
    const workflowFile = join(
      tmpRepo,
      'enclaves',
      'marketing',
      'sentiment-analyzer',
      'workflow.yaml',
    );

    // Stage a regression: workflow.yaml shows v1 but HEAD has v3.
    writeFileSync(workflowFile, 'name: sentiment-analyzer\nversion: 1\n');
    git('add enclaves/marketing/sentiment-analyzer/workflow.yaml', tmpRepo);
    execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
    // Hook sees staged (1) <= HEAD (3), so it bumps to HEAD+1 = 4.
    expect(readFileSync(workflowFile, 'utf8')).toContain('version: 4');
  });
});
