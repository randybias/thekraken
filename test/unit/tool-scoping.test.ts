import { describe, it, expect } from 'vitest';
import {
  evaluateToolCall,
  type ScopeDecision,
  type ScopeDenial,
} from '../../src/extensions/tool-scoping.js';

const MCP_PREFIX = 'mcp__tentacular__';

function allowed(decision: ReturnType<typeof evaluateToolCall>): ScopeDecision {
  expect(decision.allowed).toBe(true);
  return decision as ScopeDecision;
}

function denied(decision: ReturnType<typeof evaluateToolCall>): ScopeDenial {
  expect(decision.allowed).toBe(false);
  return decision as ScopeDenial;
}

// ---------------------------------------------------------------------------
// Non-tentacular tools
// ---------------------------------------------------------------------------

describe('Non-tentacular tools', () => {
  it('allows non-MCP tools in enclave mode', () => {
    allowed(evaluateToolCall('bash', {}, 'my-enclave'));
  });

  it('allows non-MCP tools in DM mode', () => {
    allowed(evaluateToolCall('read_file', {}, null));
  });
});

// ---------------------------------------------------------------------------
// DM mode (enclaveName = null)
// ---------------------------------------------------------------------------

describe('DM mode', () => {
  it('allows DM_ALLOWED read tools', () => {
    allowed(evaluateToolCall(`${MCP_PREFIX}wf_list`, {}, null));
    allowed(evaluateToolCall(`${MCP_PREFIX}wf_status`, {}, null));
    allowed(evaluateToolCall(`${MCP_PREFIX}wf_logs`, {}, null));
    allowed(evaluateToolCall(`${MCP_PREFIX}health_cluster_summary`, {}, null));
    allowed(evaluateToolCall(`${MCP_PREFIX}enclave_info`, {}, null));
  });

  it('blocks write tools in DM mode', () => {
    const d = denied(evaluateToolCall(`${MCP_PREFIX}wf_apply`, {}, null));
    expect(d.reason).toContain('enclave context');
  });

  it('blocks admin tools in DM mode', () => {
    const d = denied(evaluateToolCall(`${MCP_PREFIX}ns_create`, {}, null));
    expect(d.reason).toContain('enclave context');
  });

  it('blocks unknown tentacular tools in DM mode', () => {
    const d = denied(
      evaluateToolCall(`${MCP_PREFIX}some_unknown_tool`, {}, null),
    );
    expect(d.reason).toContain('enclave context');
  });

  it('does not inject namespace in DM mode', () => {
    const dec = allowed(evaluateToolCall(`${MCP_PREFIX}wf_list`, {}, null));
    expect(dec.updatedInput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enclave mode — namespace injection
// ---------------------------------------------------------------------------

describe('Enclave mode — namespace injection', () => {
  it('injects namespace for ENCLAVE_SCOPED tools', () => {
    const dec = allowed(
      evaluateToolCall(`${MCP_PREFIX}wf_list`, {}, 'marketing'),
    );
    expect(dec.updatedInput).toBeDefined();
    expect(dec.updatedInput!['namespace']).toBe('marketing');
  });

  it('injects name for enclave_info', () => {
    const dec = allowed(
      evaluateToolCall(`${MCP_PREFIX}enclave_info`, {}, 'engineering'),
    );
    expect(dec.updatedInput!['name']).toBe('engineering');
  });

  it('does not override namespace if already correct', () => {
    const dec = allowed(
      evaluateToolCall(
        `${MCP_PREFIX}wf_list`,
        { namespace: 'marketing' },
        'marketing',
      ),
    );
    expect(dec.updatedInput!['namespace']).toBe('marketing');
  });

  it('blocks cross-enclave access', () => {
    const d = denied(
      evaluateToolCall(
        `${MCP_PREFIX}wf_list`,
        { namespace: 'other-enclave' },
        'marketing',
      ),
    );
    expect(d.reason).toContain('"marketing"');
    expect(d.reason).toContain('"other-enclave"');
  });
});

// ---------------------------------------------------------------------------
// Enclave mode — blocked tools
// ---------------------------------------------------------------------------

describe('Enclave mode — blocked tools', () => {
  it('blocks ns_create in enclave mode', () => {
    const d = denied(
      evaluateToolCall(`${MCP_PREFIX}ns_create`, {}, 'marketing'),
    );
    expect(d.reason).toContain('not available in enclave mode');
  });

  it('blocks ns_delete in enclave mode', () => {
    denied(evaluateToolCall(`${MCP_PREFIX}ns_delete`, {}, 'marketing'));
  });

  it('blocks enclave_provision in enclave mode', () => {
    denied(evaluateToolCall(`${MCP_PREFIX}enclave_provision`, {}, 'marketing'));
  });

  it('blocks cluster_preflight in enclave mode', () => {
    denied(evaluateToolCall(`${MCP_PREFIX}cluster_preflight`, {}, 'marketing'));
  });

  it('blocks audit_rbac in enclave mode', () => {
    denied(evaluateToolCall(`${MCP_PREFIX}audit_rbac`, {}, 'marketing'));
  });

  it('blocks proxy_status in enclave mode', () => {
    denied(evaluateToolCall(`${MCP_PREFIX}proxy_status`, {}, 'marketing'));
  });
});

// ---------------------------------------------------------------------------
// Enclave mode — always allowed tools
// ---------------------------------------------------------------------------

describe('Enclave mode — always allowed tools', () => {
  it('allows health_cluster_summary without namespace constraint', () => {
    const dec = allowed(
      evaluateToolCall(`${MCP_PREFIX}health_cluster_summary`, {}, 'marketing'),
    );
    // No namespace injection for ALWAYS_ALLOWED tools
    expect(dec.updatedInput).toBeUndefined();
  });

  it('allows health_nodes without namespace constraint', () => {
    allowed(evaluateToolCall(`${MCP_PREFIX}health_nodes`, {}, 'marketing'));
  });
});

// ---------------------------------------------------------------------------
// Enclave mode — unknown tools
// ---------------------------------------------------------------------------

describe('Enclave mode — unknown tools', () => {
  it('blocks unknown tentacular tools for safety', () => {
    const d = denied(
      evaluateToolCall(
        `${MCP_PREFIX}some_new_tool_not_in_any_category`,
        {},
        'marketing',
      ),
    );
    expect(d.reason).toContain('not recognized');
    expect(d.reason).toContain('platform admin');
  });
});

// ---------------------------------------------------------------------------
// Multiple enclave-scoped tools
// ---------------------------------------------------------------------------

describe('Multiple enclave-scoped tools injection', () => {
  const scopedTools = [
    { tool: 'wf_describe', param: 'namespace' },
    { tool: 'wf_run', param: 'namespace' },
    { tool: 'wf_apply', param: 'namespace' },
    { tool: 'wf_restart', param: 'namespace' },
    { tool: 'wf_remove', param: 'namespace' },
    { tool: 'permissions_get', param: 'namespace' },
    { tool: 'permissions_set', param: 'namespace' },
    { tool: 'enclave_sync', param: 'name' },
  ];

  for (const { tool, param } of scopedTools) {
    it(`injects ${param} for ${tool}`, () => {
      const dec = allowed(
        evaluateToolCall(`${MCP_PREFIX}${tool}`, {}, 'test-enclave'),
      );
      expect(dec.updatedInput![param]).toBe('test-enclave');
    });
  }
});
