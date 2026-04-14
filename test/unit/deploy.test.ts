/**
 * Unit tests for the git-state deploy flow (D4).
 *
 * All git operations are mocked. No real git repos are used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import {
  deploy,
  validateExplanation,
  readVersionFromWorkflow,
  type DeployParams,
  type GitOps,
  type McpCallFn,
} from '../../src/git-state/deploy.js';
import type Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// validateExplanation
// ---------------------------------------------------------------------------

describe('validateExplanation', () => {
  it('accepts a valid explanation', () => {
    expect(
      validateExplanation('Sends daily digest to users when queue is non-empty')
        .valid,
    ).toBe(true);
  });

  it('rejects explanations that are too short', () => {
    const result = validateExplanation('Fix bug');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too short');
  });

  it('rejects explanations that are too long', () => {
    const result = validateExplanation('A'.repeat(81));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too long');
  });

  it('rejects explanations containing kubernetes jargon', () => {
    const result = validateExplanation(
      'Fixes kubernetes namespace configuration for pods',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('jargon');
  });

  it('rejects explanations containing k8s abbreviation', () => {
    const result = validateExplanation(
      'Deploy to k8s cluster for production use',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('jargon');
  });

  it('rejects boilerplate "deploy tentacle" explanations', () => {
    const result = validateExplanation('Deploy tentacle to production');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('boilerplate');
  });

  it('rejects boilerplate "WIP" explanations', () => {
    const result = validateExplanation('WIP changes for testing');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('boilerplate');
  });

  it('accepts explanation at exactly minimum length (10)', () => {
    // 10 chars exactly
    const result = validateExplanation('Sends data');
    expect(result.valid).toBe(true);
  });

  it('accepts explanation at exactly maximum length (80)', () => {
    // 80 chars exactly
    const result = validateExplanation('A'.repeat(80));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readVersionFromWorkflow
// ---------------------------------------------------------------------------

describe('readVersionFromWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kraken-deploy-test-'));
  });

  it('reads version from workflow.yaml', () => {
    const yamlPath = join(tmpDir, 'workflow.yaml');
    writeFileSync(yamlPath, 'name: my-wf\nversion: 42\n');
    expect(readVersionFromWorkflow(yamlPath)).toBe(42);
  });

  it('throws when version is missing', () => {
    const yamlPath = join(tmpDir, 'workflow.yaml');
    writeFileSync(yamlPath, 'name: my-wf\n');
    expect(() => readVersionFromWorkflow(yamlPath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deploy() with mocked git and MCP
// ---------------------------------------------------------------------------

describe('deploy()', () => {
  let db: Database.Database;
  let tmpDir: string;
  let tentacleRelPath: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    // Need an enclave_bindings row for FK
    db.prepare(
      `INSERT INTO enclave_bindings (channel_id, enclave_name, owner_slack_id)
       VALUES ('C001', 'my-enc', 'U001')`,
    ).run();

    tmpDir = mkdtempSync(join(tmpdir(), 'kraken-deploy-test-'));
    tentacleRelPath = 'enclaves/my-enc/tentacles/my-wf';
    // Create the tentacle directory and workflow.yaml
    mkdirSync(join(tmpDir, tentacleRelPath), { recursive: true });
    writeFileSync(
      join(tmpDir, tentacleRelPath, 'workflow.yaml'),
      'name: my-wf\nversion: 5\n',
    );
  });

  function makeGitOps(overrides: Partial<Record<string, string>> = {}): GitOps {
    return {
      exec: vi.fn().mockImplementation((args: string[], _cwd: string) => {
        const cmd = args.join(' ');
        if (cmd.startsWith('rev-parse HEAD'))
          return overrides['rev-parse HEAD'] ?? 'abc123def456';
        return overrides[cmd] ?? '';
      }),
    };
  }

  function makeMcpCall(returnValue: unknown = { ok: true }): McpCallFn {
    return vi.fn().mockResolvedValue(returnValue);
  }

  function makeParams(overrides: Partial<DeployParams> = {}): DeployParams {
    return {
      enclave: 'my-enc',
      tentacle: 'my-wf',
      gitDir: tmpDir,
      tentacleRelPath,
      explanation: 'Adds retry logic when upstream is unavailable',
      deployedByEmail: 'alice@example.com',
      triggeredByChannel: 'C001',
      triggeredByTs: '1234567890.000001',
      userToken: 'tok-abc',
      ...overrides,
    };
  }

  it('returns ok:true on success', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: true });
    const result = await deploy(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(true);
    expect(result.version).toBe(5);
    expect(result.gitTag).toBe('my-wf-v5');
    expect(result.gitSha).toBe('abc123def456');
  });

  it('records deployment in SQLite with status success', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: true });
    await deploy(makeParams(), db, mcpCall, git);
    const rows = db
      .prepare("SELECT * FROM deployments WHERE enclave='my-enc'")
      .all() as Array<{
      status: string;
      deploy_type: string;
      summary: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].deploy_type).toBe('deploy');
    expect(rows[0].summary).toBe(
      'Adds retry logic when upstream is unavailable',
    );
  });

  it('returns ok:false when explanation validation fails', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall();
    const result = await deploy(
      makeParams({ explanation: 'too short' }),
      db,
      mcpCall,
      git,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid deploy explanation');
    // No git ops should have been called
    expect((git.exec as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('returns ok:false when MCP wf_apply fails', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: false, message: 'tentacle not found' });
    const result = await deploy(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('tentacle not found');
  });

  it('records failed status in SQLite when MCP fails', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: false, message: 'server error' });
    await deploy(makeParams(), db, mcpCall, git);
    const rows = db
      .prepare("SELECT * FROM deployments WHERE enclave='my-enc'")
      .all() as Array<{
      status: string;
      status_detail: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].status_detail).toContain('server error');
  });

  it('returns ok:false and records failure when git throws', async () => {
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[]) => {
        if (args.includes('add')) throw new Error('git add failed');
        return '';
      }),
    };
    const mcpCall = makeMcpCall();
    const result = await deploy(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('git add failed');
  });

  it('calls git add, commit, tag, push in order', async () => {
    const calls: string[][] = [];
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[], _cwd: string) => {
        calls.push(args);
        if (args[0] === 'rev-parse') return 'deadbeef';
        return '';
      }),
    };
    const mcpCall = makeMcpCall({ ok: true });
    await deploy(makeParams(), db, mcpCall, git);

    expect(calls[0]![0]).toBe('add');
    expect(calls[1]![0]).toBe('commit');
    expect(calls[2]![0]).toBe('tag');
    expect(calls[3]![0]).toBe('push');
    expect(calls[4]).toEqual(['push', '--tags']);
  });

  it('passes user token to mcpCall', async () => {
    const git = makeGitOps();
    const mcpCall = vi.fn().mockResolvedValue({ ok: true });
    await deploy(makeParams({ userToken: 'my-user-token' }), db, mcpCall, git);
    expect(mcpCall).toHaveBeenCalledWith(
      'wf_apply',
      expect.objectContaining({ enclave: 'my-enc' }),
      'my-user-token',
    );
  });
});
