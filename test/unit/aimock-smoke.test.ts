/**
 * AIMock smoke tests.
 *
 * AIMock API notes (actual npm package @copilotkit/aimock@1.13.0):
 *
 * LLMock:
 *   - onMessage(pattern, response) registers a fixture by user message pattern.
 *   - After start(), llmock.url and llmock.port are available.
 *
 * MCPMock:
 *   - addTool(def) registers a tool definition.
 *   - onToolCall(name, handlerFn) registers a handler function (not a match+value pair).
 *     The handler receives the call args and must return the result value.
 *     MCPMock wraps the return value in MCP content format.
 *   - After start(), mock.server.address().port gives the actual port.
 *     mock.port is undefined (not populated by this version).
 *   - MCP 2025-03-26 Streamable HTTP protocol requires:
 *     1. POST /mcp { method: "initialize" } → returns session ID in Mcp-Session-Id header
 *     2. POST /mcp { method: "notifications/initialized" } with Mcp-Session-Id header
 *     3. POST /mcp { method: "tools/call" } with Mcp-Session-Id header
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMock, MCPMock } from '@copilotkit/aimock';

// Helper: run the MCP initialize + notifications/initialized handshake
async function mcpHandshake(
  baseUrl: string,
): Promise<{ sessionId: string; commonHeaders: Record<string, string> }> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json,text/event-stream',
  };

  const initRes = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
      id: 1,
    }),
  });

  const sessionId = initRes.headers.get('mcp-session-id') ?? '';
  await initRes.body?.cancel();

  // Send initialized notification (no response expected — 202)
  await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return {
    sessionId,
    commonHeaders: { ...headers, 'Mcp-Session-Id': sessionId },
  };
}

describe('AIMock smoke: LLMock', () => {
  let llmock: LLMock;

  beforeEach(async () => {
    llmock = new LLMock({ port: 0 });
    await llmock.start();
  });

  afterEach(async () => {
    await llmock.stop();
  });

  it('intercepts an Anthropic-format messages call and returns mock content', async () => {
    llmock.onMessage('test', { content: 'Hello from mock' });

    const res = await fetch(`${llmock.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content[0]).toBeDefined();
    expect(body.content[0]!.text).toBe('Hello from mock');
  });

  it('exposes a valid url and port after start', () => {
    expect(llmock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(llmock.port).toBeGreaterThan(0);
  });
});

describe('AIMock smoke: MCPMock', () => {
  let mcpmock: MCPMock;
  let mcpBaseUrl: string;

  beforeEach(async () => {
    mcpmock = new MCPMock({ port: 0 });
    mcpmock.addTool({
      name: 'ns_list',
      description: 'List namespaces',
      inputSchema: { type: 'object', properties: {} },
    });
    // onToolCall takes a handler function (not a match+value)
    mcpmock.onToolCall('ns_list', (_args: unknown) => ({
      namespaces: ['marketing', 'engineering'],
    }));
    await mcpmock.start();

    // mock.port is undefined in this version; get port from server.address()
    const addr = (
      mcpmock as unknown as { server: { address(): { port: number } } }
    ).server.address();
    mcpBaseUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterEach(async () => {
    await mcpmock.stop();
  });

  it('completes MCP initialize handshake and returns a session ID', async () => {
    const res = await fetch(mcpBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
        id: 1,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      result: { serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.serverInfo.name).toBe('mcp-mock');

    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
  });

  it('returns mocked ns_list tool result after full MCP handshake', async () => {
    const { commonHeaders } = await mcpHandshake(mcpBaseUrl);

    const res = await fetch(mcpBaseUrl, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'ns_list', arguments: {} },
        id: 2,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.isError).toBe(false);

    // MCPMock wraps the handler return value in MCP content format.
    // The tool is registered and the call succeeds (isError false).
    // Response content is present (format depends on MCPMock version internals).
    const content = body.result.content[0];
    expect(content).toBeDefined();
    expect(content!.type).toBe('text');
  });
});
