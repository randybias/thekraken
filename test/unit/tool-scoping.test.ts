import { describe, it, expect } from 'vitest';
import {
  evaluateToolCall,
  getAllowedTentacularTools,
} from '../../src/extensions/tool-scoping.js';

const MCP = 'mcp__tentacular__';

describe('evaluateToolCall', () => {
  describe('enclave mode', () => {
    const enclave = 'my-enclave';
    it('injects enclave for scoped tools', () => {
      const r = evaluateToolCall(`${MCP}wf_list`, {}, enclave);
      expect(r.allowed).toBe(true);
      if (r.allowed) expect(r.updatedInput).toEqual({ enclave });
    });
    it('blocks cross-enclave access', () => {
      const r = evaluateToolCall(
        `${MCP}wf_list`,
        { enclave: 'other' },
        enclave,
      );
      expect(r.allowed).toBe(false);
    });
    it('blocks platform operator tools', () => {
      expect(
        evaluateToolCall(`${MCP}enclave_preflight`, {}, enclave).allowed,
      ).toBe(false);
    });
    it('allows health_cluster_summary without injection', () => {
      const r = evaluateToolCall(`${MCP}health_cluster_summary`, {}, enclave);
      expect(r.allowed).toBe(true);
      if (r.allowed) expect(r.updatedInput).toBeUndefined();
    });
    it('blocks unknown tentacular tools', () => {
      expect(evaluateToolCall(`${MCP}future_tool`, {}, enclave).allowed).toBe(
        false,
      );
    });
  });
  describe('full table coverage', () => {
    it('all ENCLAVE_SCOPED tools are allowed and inject enclave or name param', () => {
      const scopedTools = [
        'wf_list',
        'wf_describe',
        'wf_status',
        'wf_pods',
        'wf_logs',
        'wf_events',
        'wf_jobs',
        'wf_health',
        'wf_health_enclave',
        'wf_apply',
        'wf_run',
        'wf_restart',
        'wf_remove',
        'permissions_get',
        'permissions_set',
        'ns_permissions_get',
        'ns_permissions_set',
      ];
      for (const tool of scopedTools) {
        const result = evaluateToolCall(`${MCP}${tool}`, {}, 'test-enclave');
        expect(result.allowed, `${tool} should be allowed`).toBe(true);
        if (result.allowed && result.updatedInput) {
          expect(
            'enclave' in result.updatedInput || 'name' in result.updatedInput,
            `${tool} should inject 'enclave' or 'name'`,
          ).toBe(true);
          expect(
            'namespace' in result.updatedInput,
            `${tool} must not inject 'namespace'`,
          ).toBe(false);
        }
      }
    });

    it('all BLOCKED_IN_ENCLAVE tools are denied', () => {
      const blocked = [
        'ns_create',
        'ns_update',
        'ns_delete',
        'ns_list',
        'enclave_provision',
        'enclave_deprovision',
        'enclave_list',
        'enclave_preflight',
        'cluster_profile',
        'audit_rbac',
        'audit_netpol',
        'audit_psa',
        'gvisor_check',
        'exo_status',
        'exo_registration',
        'exo_list',
        'proxy_status',
      ];
      for (const tool of blocked) {
        const result = evaluateToolCall(`${MCP}${tool}`, {}, 'test-enclave');
        expect(
          result.allowed,
          `${tool} should be blocked in enclave mode`,
        ).toBe(false);
      }
    });
  });

  describe('DM mode', () => {
    it('allows read-only tools', () => {
      expect(evaluateToolCall(`${MCP}wf_list`, {}, null).allowed).toBe(true);
    });
    it('blocks write tools', () => {
      expect(evaluateToolCall(`${MCP}wf_apply`, {}, null).allowed).toBe(false);
    });
  });
  describe('non-tentacular tools', () => {
    it('allows non-MCP tools', () => {
      expect(
        evaluateToolCall('Bash', { command: 'ls' }, 'my-enclave').allowed,
      ).toBe(true);
    });
  });
});

describe('getAllowedTentacularTools', () => {
  it('returns scoped + always-allowed for enclave mode', () => {
    const tools = getAllowedTentacularTools('my-enclave');
    expect(tools).toContain(`${MCP}wf_list`);
    expect(tools).toContain(`${MCP}wf_apply`);
    expect(tools).not.toContain(`${MCP}enclave_provision`);
  });
  it('returns read-only for DM mode', () => {
    const tools = getAllowedTentacularTools(null);
    expect(tools).toContain(`${MCP}wf_list`);
    expect(tools).not.toContain(`${MCP}wf_apply`);
  });
});
