/**
 * Unit test for kraken-hooks/pre-commit.
 *
 * Creates a temporary git repository fixture with a mock enclave/tentacle
 * structure, stages a change, runs the hook, and asserts the version is
 * incremented.
 *
 * Also covers the hardcoded-secret gate: staged files containing credential
 * patterns must cause the hook to exit non-zero.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
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
  it(
    'bumps version when a tentacle source file is staged',
    { timeout: 20000 },
    () => {
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
    },
  );

  it(
    'does NOT bump version when only CONTEXT.md is staged',
    { timeout: 20000 },
    () => {
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
    },
  );

  it(
    'exits 0 when no files under enclaves/ are staged',
    { timeout: 20000 },
    () => {
      // Stage a file outside enclaves/
      writeFileSync(join(tmpRepo, 'README.md'), 'hello\n');
      git('add README.md', tmpRepo);

      // Should succeed without error
      expect(() => {
        execSync(`bash "${HOOK_PATH}"`, { cwd: tmpRepo });
      }).not.toThrow();
    },
  );

  it('bumps only the affected tentacle, not others', { timeout: 20000 }, () => {
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
  // Timeout raised: hook runs 3× in this test; each run includes the secret scan
  // which adds ~1s per invocation on a cold git process.

  it(
    'does not re-bump when the hook is run twice on the same staged set',
    { timeout: 20000 },
    () => {
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
    },
  );

  it(
    'respects a manual version bump (does not double-bump)',
    { timeout: 20000 },
    () => {
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
    },
  );

  it(
    'uses HEAD+1 not staged+1 to compute the new version',
    { timeout: 20000 },
    () => {
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
    },
  );
});

// ---------------------------------------------------------------------------
// Secret scanning gate tests
// ---------------------------------------------------------------------------

/**
 * Run the hook and return { exitCode, stderr }.
 * Uses spawnSync so we can capture the exit code without throwing.
 */
function runHook(
  cwd: string,
  env?: Record<string, string>,
): { exitCode: number; stderr: string } {
  const result = spawnSync('bash', [HOOK_PATH], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

describe('pre-commit hook — hardcoded-secret gate', () => {
  let scanRepo: string;

  beforeEach(() => {
    // Minimal repo: no enclave structure needed for secret scan tests.
    scanRepo = mkdtempSync(join(tmpdir(), 'kraken-scan-test-'));
    execSync('git init', { cwd: scanRepo });
    execSync('git config user.email "test@example.com"', { cwd: scanRepo });
    execSync('git config user.name "Test"', { cwd: scanRepo });

    // Initial empty commit so HEAD exists
    writeFileSync(join(scanRepo, 'README.md'), '# test\n');
    execSync('git add README.md', { cwd: scanRepo });
    execSync('git commit -m "init" --no-verify', { cwd: scanRepo });
  });

  afterEach(() => {
    rmSync(scanRepo, { recursive: true, force: true });
  });

  it('rejects a staged file containing an Anthropic API key', () => {
    writeFileSync(
      join(scanRepo, 'node.ts'),
      'const key = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add node.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('node.ts');
    expect(stderr).toContain('sk-ant-');
  });

  it('rejects a staged file containing an OpenAI sk-proj- key', () => {
    writeFileSync(
      join(scanRepo, 'llm.ts'),
      'const key = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add llm.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('sk-proj-');
  });

  it('rejects a staged file containing a Slack xoxb- token', () => {
    writeFileSync(
      join(scanRepo, 'slack.ts'),
      'const token = "xoxb-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add slack.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('xox');
  });

  it('rejects a staged file containing a Slack xapp- token', () => {
    writeFileSync(
      join(scanRepo, 'slack-app.ts'),
      'const appToken = "xapp-1-FAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add slack-app.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
  });

  it('rejects a staged file containing an AWS access key', () => {
    writeFileSync(
      join(scanRepo, 'aws.ts'),
      'const accessKey = "AKIAFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add aws.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('AKIA');
  });

  it('rejects a staged file containing a GitHub PAT', () => {
    writeFileSync(
      join(scanRepo, 'gh.ts'),
      'const pat = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add gh.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('ghp_');
  });

  it('rejects a staged file containing a private key header', () => {
    writeFileSync(
      join(scanRepo, 'key.pem'),
      '-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----\n',
    );
    execSync('git add key.pem', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
    expect(stderr).toContain('PRIVATE KEY');
  });

  it('rejects a staged file containing an Azure SAS token', () => {
    writeFileSync(
      join(scanRepo, 'azure.ts'),
      'const sas = "https://example.blob.core.windows.net/c?sv=2020-08-04&sig=FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add azure.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Hardcoded credentials detected');
  });

  it('allows a staged .secrets.yaml file (excluded from scan)', () => {
    // .secrets.yaml legitimately contains $shared references, not real values.
    // It must not be scanned even if its content looks suspicious.
    writeFileSync(
      join(scanRepo, '.secrets.yaml'),
      'openai: $shared.openai\nslack: $shared.slack\n',
    );
    execSync('git add .secrets.yaml', { cwd: scanRepo });

    const { exitCode } = runHook(scanRepo);
    expect(exitCode).toBe(0);
  });

  it('allows a staged SOPS-encrypted .enc.yaml file (excluded from scan)', () => {
    writeFileSync(
      join(scanRepo, 'secrets.enc.yaml'),
      'sops:\n  version: 3\nciphertext: SOMETHINGENCODED==\n',
    );
    execSync('git add secrets.enc.yaml', { cwd: scanRepo });

    const { exitCode } = runHook(scanRepo);
    expect(exitCode).toBe(0);
  });

  it('allows commit when KRAKEN_ALLOW_SECRET_SCAN_BYPASS=1 even with a real-looking token', () => {
    writeFileSync(
      join(scanRepo, 'node.ts'),
      'const key = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add node.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo, {
      KRAKEN_ALLOW_SECRET_SCAN_BYPASS: '1',
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain('KRAKEN_ALLOW_SECRET_SCAN_BYPASS=1');
    expect(stderr).toContain('bypassing');
  });

  it('allows a staged file with no credential patterns', () => {
    writeFileSync(
      join(scanRepo, 'main.ts'),
      'export const greeting = "hello world";\n',
    );
    execSync('git add main.ts', { cwd: scanRepo });

    const { exitCode } = runHook(scanRepo);
    expect(exitCode).toBe(0);
  });

  it('stderr message includes remediation instructions', () => {
    writeFileSync(
      join(scanRepo, 'bad.ts'),
      'const key = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";\n',
    );
    execSync('git add bad.ts', { cwd: scanRepo });

    const { exitCode, stderr } = runHook(scanRepo);
    expect(exitCode).not.toBe(0);
    // Must name the correct fix path
    expect(stderr).toContain('$shared');
    expect(stderr).toContain('ctx.dependency');
    expect(stderr).toContain('secrets.md');
  });
});
