import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ENCLAVE_SCOPED,
  BLOCKED_IN_ENCLAVE,
  DM_ALLOWED,
  ALWAYS_ALLOWED,
  ALL_MCP_TOOLS,
} from '../../src/agent/mcp-connection.js';

// Test the category constants and tool name utilities without connecting to a server

describe('MCP tool category constants', () => {
  it('ENCLAVE_SCOPED contains expected tools', () => {
    expect(ENCLAVE_SCOPED).toContain('wf_list');
    expect(ENCLAVE_SCOPED).toContain('wf_status');
    expect(ENCLAVE_SCOPED).toContain('wf_logs');
    expect(ENCLAVE_SCOPED).toContain('permissions_get');
    expect(ENCLAVE_SCOPED).toContain('audit_rbac');
  });

  it('BLOCKED_IN_ENCLAVE contains enclave admin tools', () => {
    expect(BLOCKED_IN_ENCLAVE).toContain('enclave_provision');
    expect(BLOCKED_IN_ENCLAVE).toContain('enclave_deprovision');
    expect(BLOCKED_IN_ENCLAVE).toContain('enclave_preflight');
    expect(BLOCKED_IN_ENCLAVE).toContain('cluster_profile');
  });

  it('DM_ALLOWED contains cross-enclave read tools', () => {
    expect(DM_ALLOWED).toContain('enclave_list');
  });

  it('ALWAYS_ALLOWED contains cluster-wide read-only tools', () => {
    expect(ALWAYS_ALLOWED).toContain('health_cluster_summary');
    expect(ALWAYS_ALLOWED).toContain('health_nodes');
  });

  it('ALL_MCP_TOOLS is the union of all categories', () => {
    const expected = new Set([
      ...ENCLAVE_SCOPED,
      ...BLOCKED_IN_ENCLAVE,
      ...DM_ALLOWED,
      ...ALWAYS_ALLOWED,
    ]);
    expect(new Set(ALL_MCP_TOOLS)).toEqual(expected);
  });

  it('ALL_MCP_TOOLS has no duplicates', () => {
    expect(new Set(ALL_MCP_TOOLS).size).toBe(ALL_MCP_TOOLS.length);
  });

  it('tool categories are disjoint (no tool in two categories)', () => {
    const sets = [
      new Set(ENCLAVE_SCOPED),
      new Set(BLOCKED_IN_ENCLAVE),
      new Set(DM_ALLOWED),
      new Set(ALWAYS_ALLOWED),
    ];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        for (const tool of sets[i]!) {
          expect(sets[j]!.has(tool)).toBe(false);
        }
      }
    }
  });
});

// Test createMcpConnection using a mocked MCP Client

describe('createMcpConnection (with mocked Client)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters server tools to only known MCP tools', async () => {
    // Mock the MCP SDK Client
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        listTools = vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'wf_list',
              description: 'List workflows',
              inputSchema: { type: 'object' },
            },
            { name: 'unknown_tool', description: 'Unknown', inputSchema: {} },
            {
              name: 'wf_status',
              description: 'Status',
              inputSchema: { type: 'object' },
            },
          ],
        });
        callTool = vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'result' }],
        });
        ping = vi.fn().mockResolvedValue(undefined);
      },
    }));

    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: class MockTransport {
        constructor(_url: URL, _opts: unknown) {}
      },
    }));

    const { createMcpConnection } =
      await import('../../src/agent/mcp-connection.js');
    const conn = await createMcpConnection('http://mcp:8080', 'test-token');

    // Should have tools for wf_list and wf_status but NOT unknown_tool
    const toolNames = conn.tools.map((t) => t.name);
    expect(toolNames).toContain('wf_list');
    expect(toolNames).toContain('wf_status');
    expect(toolNames).not.toContain('unknown_tool');
  });

  it('healthCheck returns true when ping succeeds', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        listTools = vi.fn().mockResolvedValue({ tools: [] });
        ping = vi.fn().mockResolvedValue(undefined);
      },
    }));

    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: class MockTransport {
        constructor(_url: URL, _opts: unknown) {}
      },
    }));

    const { createMcpConnection } =
      await import('../../src/agent/mcp-connection.js');
    const conn = await createMcpConnection('http://mcp:8080', 'test-token');
    expect(await conn.healthCheck()).toBe(true);
  });

  it('healthCheck returns false when ping fails', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        listTools = vi.fn().mockResolvedValue({ tools: [] });
        ping = vi.fn().mockRejectedValue(new Error('connection refused'));
      },
    }));

    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: class MockTransport {
        constructor(_url: URL, _opts: unknown) {}
      },
    }));

    const { createMcpConnection } =
      await import('../../src/agent/mcp-connection.js');
    const conn = await createMcpConnection('http://mcp:8080', 'test-token');
    expect(await conn.healthCheck()).toBe(false);
  });

  it('each tool has name, label, description, parameters, and execute', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        listTools = vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'wf_list',
              description: 'List workflows',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
        callTool = vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'workflows: []' }],
        });
        ping = vi.fn().mockResolvedValue(undefined);
      },
    }));

    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: class MockTransport {
        constructor(_url: URL, _opts: unknown) {}
      },
    }));

    const { createMcpConnection } =
      await import('../../src/agent/mcp-connection.js');
    const conn = await createMcpConnection('http://mcp:8080', 'test-token');

    expect(conn.tools).toHaveLength(1);
    const tool = conn.tools[0]!;
    expect(tool.name).toBe('wf_list');
    expect(tool.label).toBe('wf list');
    expect(tool.description).toBe('List workflows');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });
});
