/**
 * Smart-path tool allowlist enforcement.
 *
 * The 2026-05-04 incident exposed that smart-path exposes the entire
 * MCP tool catalog to the LLM. This file proves the allowlist is the
 * single source of truth for what the LLM can call, regardless of
 * what MCP advertises.
 */
import { describe, it, expect } from 'vitest';
import {
  MODE_TOOL_ALLOWLIST,
  filterToolsForMode,
  type SmartPathMode,
} from '../../src/dispatcher/smart-path.js';

interface FakeTool {
  name: string;
}

const ALL_TOOLS: FakeTool[] = [
  { name: 'enclave_list' },
  { name: 'enclave_info' },
  { name: 'enclave_provision' },
  { name: 'enclave_deprovision' },
  { name: 'wf_list' },
  { name: 'wf_apply' },
  { name: 'wf_run' },
  { name: 'wf_describe' },
  { name: 'wf_status' },
];

describe('MODE_TOOL_ALLOWLIST', () => {
  it('exposes only enclave_list in dm mode', () => {
    expect(MODE_TOOL_ALLOWLIST.dm).toEqual(['enclave_list']);
  });

  it('exposes only enclave_provision in provision mode', () => {
    expect(MODE_TOOL_ALLOWLIST.provision).toEqual(['enclave_provision']);
  });
});

describe('filterToolsForMode', () => {
  for (const mode of ['dm', 'provision'] as SmartPathMode[]) {
    it(`drops every tool not in MODE_TOOL_ALLOWLIST.${mode}`, () => {
      const filtered = filterToolsForMode(ALL_TOOLS, mode);
      const allowed = MODE_TOOL_ALLOWLIST[mode];
      expect(filtered.map((t) => t.name)).toEqual(allowed as string[]);
    });
  }

  it('returns empty list when MCP advertises nothing', () => {
    expect(filterToolsForMode([], 'dm')).toEqual([]);
  });

  it('returns empty list when MCP advertises only disallowed tools', () => {
    const onlyDisallowed: FakeTool[] = [
      { name: 'wf_apply' },
      { name: 'enclave_deprovision' },
    ];
    expect(filterToolsForMode(onlyDisallowed, 'dm')).toEqual([]);
  });
});
