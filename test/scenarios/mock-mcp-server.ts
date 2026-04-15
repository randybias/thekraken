/**
 * Mock MCP HTTP server for real-LLM scenario tests.
 *
 * Listens on a random port. Responds to:
 *   POST /mcp/tools/list    — returns a list of available tools
 *   POST /mcp/tools/call    — returns scripted responses keyed by tool name
 *
 * Records all tool calls in `calls` array for assertion.
 * Returns proper MCP response format:
 *   { content: [{ type: 'text', text: JSON.stringify(data) }] }
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  tool: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export interface MockMcpServerOptions {
  /**
   * Scripted responses keyed by tool name.
   * Each value is a list of responses returned FIFO.
   * Once exhausted, returns { ok: true }.
   */
  responses?: Record<string, unknown[]>;
}

export interface MockMcpServer {
  /** Base URL for this server: http://localhost:<port> */
  url: string;
  /** All recorded tool calls since start. */
  calls: RecordedCall[];
  /** Stop the server. */
  close(): Promise<void>;
}

/**
 * Tool schema definitions for the tools we mock.
 * Minimal InputSchema so the agent knows what args to pass.
 */
const MOCK_TOOL_SCHEMAS: Record<
  string,
  { description: string; inputSchema: object }
> = {
  wf_list: {
    description: 'List all workflows in an enclave namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
      },
      required: ['enclave'],
    },
  },
  wf_health_enclave: {
    description: 'Get health status for all workflows in an enclave.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
      },
      required: ['enclave'],
    },
  },
  wf_describe: {
    description: 'Describe a specific workflow in detail.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
        name: { type: 'string', description: 'Workflow name' },
      },
      required: ['enclave', 'name'],
    },
  },
  wf_logs: {
    description: 'Fetch recent logs for a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
        name: { type: 'string', description: 'Workflow name' },
        lines: {
          type: 'number',
          description: 'Number of log lines to return',
        },
      },
      required: ['enclave', 'name'],
    },
  },
  enclave_info: {
    description: 'Get information about the enclave including members.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
      },
      required: ['enclave'],
    },
  },
  enclave_sync: {
    description: 'Sync enclave membership (add/remove users).',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
        add: {
          type: 'array',
          items: { type: 'string' },
          description: 'Slack user IDs to add',
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Slack user IDs to remove',
        },
      },
      required: ['enclave'],
    },
  },
  enclave_deprovision: {
    description:
      'Permanently delete an enclave and all its workflows. DESTRUCTIVE.',
    inputSchema: {
      type: 'object',
      properties: {
        enclave: { type: 'string', description: 'Enclave (namespace) name' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to confirm deletion',
        },
      },
      required: ['enclave', 'confirm'],
    },
  },
};

/**
 * Read the full body of an incoming HTTP request.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Create and start a mock MCP HTTP server on a random port.
 *
 * @param opts - Configuration options including scripted responses.
 * @returns A handle with the server URL, recorded calls, and a close() method.
 */
export function startMockMcpServer(
  opts: MockMcpServerOptions = {},
): Promise<MockMcpServer> {
  const responseQueues = new Map<string, unknown[]>();
  for (const [tool, responses] of Object.entries(opts.responses ?? {})) {
    responseQueues.set(tool, [...responses]);
  }

  const calls: RecordedCall[] = [];

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';

    // CORS headers for any client
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && url === '/mcp/tools/list') {
      // Return the list of available tool schemas
      const tools = Object.entries(MOCK_TOOL_SCHEMAS).map(([name, schema]) => ({
        name,
        description: schema.description,
        inputSchema: schema.inputSchema,
      }));
      sendJson(res, 200, { tools });
      return;
    }

    if (req.method === 'POST' && url === '/mcp/tools/call') {
      void readBody(req)
        .then((rawBody) => {
          let toolName = 'unknown';
          let params: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(rawBody) as {
              name?: string;
              arguments?: Record<string, unknown>;
            };
            toolName = parsed.name ?? 'unknown';
            params = parsed.arguments ?? {};
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }

          calls.push({ tool: toolName, params, timestamp: Date.now() });

          // Look up scripted response
          const queue = responseQueues.get(toolName);
          let responseData: unknown;
          if (queue && queue.length > 0) {
            responseData = queue.shift();
          } else {
            // Default fallback responses
            responseData = { ok: true };
          }

          const mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(responseData),
              },
            ],
          };

          sendJson(res, 200, mcpResponse);
        })
        .catch((err: unknown) => {
          sendJson(res, 500, { error: String(err) });
        });
      return;
    }

    // Health check
    if (req.method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found', url });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;

      resolve({
        url,
        calls,
        close(): Promise<void> {
          return new Promise((r, e) => {
            server.close((err) => {
              if (err) e(err);
              else r();
            });
          });
        },
      });
    });
  });
}
