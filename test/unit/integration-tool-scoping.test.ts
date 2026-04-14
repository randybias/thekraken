/**
 * T15: Integration test — tool scoping.
 *
 * Verifies the evaluateToolCall pure function behaves correctly for the
 * complete set of scenarios required by the design:
 *   - Enclave mode: namespace injected, wrong namespace blocked, admin blocked
 *   - DM mode: read-only allowed, write blocked
 *
 * This exercises the same logic as the pi extension's tool_call handler
 * (which is tested via the pure function to avoid needing pi infrastructure).
 */

import { describe, it, expect } from 'vitest';
import { evaluateToolCall } from '../../src/extensions/tool-scoping.js';

const MCP = 'mcp__tentacular__';
const ENCLAVE = 'data-engineering';

describe('T15: Tool scoping — enclave mode', () => {
  it('injects namespace into wf_list', () => {
    const dec = evaluateToolCall(`${MCP}wf_list`, {}, ENCLAVE);
    expect(dec.allowed).toBe(true);
    if (dec.allowed) {
      expect(dec.updatedInput!['namespace']).toBe(ENCLAVE);
    }
  });

  it('injects namespace into wf_apply (write tool)', () => {
    const dec = evaluateToolCall(`${MCP}wf_apply`, {}, ENCLAVE);
    expect(dec.allowed).toBe(true);
    if (dec.allowed) {
      expect(dec.updatedInput!['namespace']).toBe(ENCLAVE);
    }
  });

  it('injects namespace into wf_run (execute tool)', () => {
    const dec = evaluateToolCall(`${MCP}wf_run`, {}, ENCLAVE);
    expect(dec.allowed).toBe(true);
    if (dec.allowed) {
      expect(dec.updatedInput!['namespace']).toBe(ENCLAVE);
    }
  });

  it('blocks wrong namespace (cross-enclave)', () => {
    const dec = evaluateToolCall(
      `${MCP}wf_list`,
      { namespace: 'other-team' },
      ENCLAVE,
    );
    expect(dec.allowed).toBe(false);
    if (!dec.allowed) {
      expect(dec.reason).toContain('"data-engineering"');
      expect(dec.reason).toContain('"other-team"');
    }
  });

  it('blocks ns_create (admin tool) in enclave mode', () => {
    const dec = evaluateToolCall(`${MCP}ns_create`, {}, ENCLAVE);
    expect(dec.allowed).toBe(false);
    if (!dec.allowed) {
      expect(dec.reason).toContain('not available in enclave mode');
    }
  });

  it('blocks ns_delete (admin tool) in enclave mode', () => {
    const dec = evaluateToolCall(`${MCP}ns_delete`, {}, ENCLAVE);
    expect(dec.allowed).toBe(false);
  });

  it('blocks enclave_provision in enclave mode', () => {
    const dec = evaluateToolCall(`${MCP}enclave_provision`, {}, ENCLAVE);
    expect(dec.allowed).toBe(false);
  });

  it('blocks audit_rbac in enclave mode', () => {
    const dec = evaluateToolCall(`${MCP}audit_rbac`, {}, ENCLAVE);
    expect(dec.allowed).toBe(false);
  });

  it('allows health_cluster_summary (always allowed)', () => {
    const dec = evaluateToolCall(`${MCP}health_cluster_summary`, {}, ENCLAVE);
    expect(dec.allowed).toBe(true);
  });

  it('blocks unknown tool for safety', () => {
    const dec = evaluateToolCall(`${MCP}brand_new_tool_v99`, {}, ENCLAVE);
    expect(dec.allowed).toBe(false);
    if (!dec.allowed) {
      expect(dec.reason).toContain('not recognized');
    }
  });
});

describe('T15: Tool scoping — DM mode', () => {
  it('allows read tool in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_list`, {}, null);
    expect(dec.allowed).toBe(true);
  });

  it('allows wf_status in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_status`, {}, null);
    expect(dec.allowed).toBe(true);
  });

  it('allows enclave_info in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}enclave_info`, {}, null);
    expect(dec.allowed).toBe(true);
  });

  it('blocks wf_apply (write) in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_apply`, {}, null);
    expect(dec.allowed).toBe(false);
    if (!dec.allowed) {
      expect(dec.reason).toContain('enclave context');
    }
  });

  it('blocks wf_run in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_run`, {}, null);
    expect(dec.allowed).toBe(false);
  });

  it('blocks wf_remove in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_remove`, {}, null);
    expect(dec.allowed).toBe(false);
  });

  it('blocks ns_create in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}ns_create`, {}, null);
    expect(dec.allowed).toBe(false);
  });

  it('does NOT inject namespace in DM mode', () => {
    const dec = evaluateToolCall(`${MCP}wf_list`, {}, null);
    expect(dec.allowed).toBe(true);
    if (dec.allowed) {
      expect(dec.updatedInput).toBeUndefined();
    }
  });
});
