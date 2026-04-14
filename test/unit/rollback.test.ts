/**
 * Unit tests for the git-state rollback flow (D5).
 *
 * All git operations are mocked. No real git repos are used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDatabase } from '../../src/db/migrations.js';
import { rollback, type RollbackParams } from '../../src/git-state/rollback.js';
import type { GitOps, McpCallFn } from '../../src/git-state/deploy.js';
import type Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('rollback()', () => {
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

    tmpDir = mkdtempSync(join(tmpdir(), 'kraken-rollback-test-'));
    tentacleRelPath = 'enclaves/my-enc/tentacles/my-wf';
    mkdirSync(join(tmpDir, tentacleRelPath), { recursive: true });
    writeFileSync(
      join(tmpDir, tentacleRelPath, 'workflow.yaml'),
      'name: my-wf\nversion: 7\n',
    );
  });

  function makeGitOps(tagSha = 'oldsha123'): GitOps {
    return {
      exec: vi.fn().mockImplementation((args: string[], _cwd: string) => {
        if (args[0] === 'rev-list') return tagSha;
        if (args[0] === 'rev-parse') return 'newsha456';
        return '';
      }),
    };
  }

  function makeMcpCall(returnValue: unknown = { ok: true }): McpCallFn {
    return vi.fn().mockResolvedValue(returnValue);
  }

  function makeParams(overrides: Partial<RollbackParams> = {}): RollbackParams {
    return {
      enclave: 'my-enc',
      tentacle: 'my-wf',
      targetTag: 'my-wf-v3',
      gitDir: tmpDir,
      tentacleRelPath,
      requestedByEmail: 'alice@example.com',
      triggeredByChannel: 'C001',
      triggeredByTs: '1234567890.000001',
      userToken: 'tok-abc',
      ...overrides,
    };
  }

  it('returns ok:true on success', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: true });
    const result = await rollback(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(true);
    expect(result.newVersion).toBe(7);
    expect(result.newTag).toBe('my-wf-v7');
    expect(result.gitSha).toBe('newsha456');
  });

  it('records rollback in SQLite with status success', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: true });
    await rollback(makeParams(), db, mcpCall, git);
    const rows = db
      .prepare("SELECT * FROM deployments WHERE enclave='my-enc'")
      .all() as Array<{ status: string; deploy_type: string; summary: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].deploy_type).toBe('rollback');
    expect(rows[0].summary).toContain('my-wf-v3');
  });

  it('returns ok:false when target tag does not exist', async () => {
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[]) => {
        if (args[0] === 'rev-list') return ''; // empty = not found
        return '';
      }),
    };
    const mcpCall = makeMcpCall();
    const result = await rollback(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('does not exist');
  });

  it('returns ok:false when git rev-list throws (tag not found)', async () => {
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[]) => {
        if (args[0] === 'rev-list') throw new Error('unknown revision');
        return '';
      }),
    };
    const mcpCall = makeMcpCall();
    const result = await rollback(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('does not exist');
  });

  it('returns ok:false when MCP wf_apply fails', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: false, message: 'wf_apply error' });
    const result = await rollback(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('wf_apply error');
  });

  it('records failed status when MCP fails', async () => {
    const git = makeGitOps();
    const mcpCall = makeMcpCall({ ok: false, message: 'server error' });
    await rollback(makeParams(), db, mcpCall, git);
    const rows = db
      .prepare("SELECT * FROM deployments WHERE enclave='my-enc'")
      .all() as Array<{ status: string; status_detail: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
  });

  it('calls git checkout, add, commit, tag, push in order', async () => {
    const calls: string[][] = [];
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[]) => {
        calls.push(args);
        if (args[0] === 'rev-list') return 'abc123';
        if (args[0] === 'rev-parse') return 'newsha';
        return '';
      }),
    };
    const mcpCall = makeMcpCall({ ok: true });
    await rollback(makeParams(), db, mcpCall, git);

    const checkoutIdx = calls.findIndex((c) => c[0] === 'checkout');
    const addIdx = calls.findIndex((c) => c[0] === 'add');
    const commitIdx = calls.findIndex((c) => c[0] === 'commit');
    const tagIdx = calls.findIndex((c) => c[0] === 'tag');
    expect(checkoutIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(checkoutIdx);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(tagIdx).toBeGreaterThan(commitIdx);
  });

  it('passes user token to mcpCall', async () => {
    const git = makeGitOps();
    const mcpCall = vi.fn().mockResolvedValue({ ok: true });
    await rollback(
      makeParams({ userToken: 'my-user-token' }),
      db,
      mcpCall,
      git,
    );
    expect(mcpCall).toHaveBeenCalledWith(
      'wf_apply',
      expect.objectContaining({ enclave: 'my-enc' }),
      'my-user-token',
    );
  });

  it('returns error message when git checkout throws', async () => {
    const git: GitOps = {
      exec: vi.fn().mockImplementation((args: string[]) => {
        if (args[0] === 'rev-list') return 'abc123';
        if (args[0] === 'checkout') throw new Error('git checkout failed');
        return '';
      }),
    };
    const mcpCall = makeMcpCall();
    const result = await rollback(makeParams(), db, mcpCall, git);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('git checkout failed');
  });
});
