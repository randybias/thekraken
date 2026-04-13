/**
 * MCPMock — a lightweight mock for @modelcontextprotocol/sdk Client.
 *
 * Intercepts Client constructor calls during tests to avoid real HTTP
 * connections. Provides scripted tool lists and tool call results.
 *
 * Usage:
 *   const mock = new MCPMock();
 *   mock.tools = [{ name: 'wf_list', description: 'List workflows', inputSchema: {} }];
 *   mock.install(); // patches module-level Client
 *   // ... run code under test ...
 *   mock.restore();
 */

export interface MockMcpTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface MockToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class MCPMock {
  /** Tools returned by listTools(). */
  tools: MockMcpTool[] = [];

  /** Scripted tool call results keyed by tool name. */
  private toolResults: Record<string, MockToolCallResult[]> = {};

  /** All tool calls recorded during this mock's lifetime. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  private connected = false;

  /**
   * Register a scripted response for a tool call.
   * Responses are consumed FIFO; unscripted calls return a default result.
   */
  addToolResult(toolName: string, result: MockToolCallResult): void {
    if (!this.toolResults[toolName]) {
      this.toolResults[toolName] = [];
    }
    this.toolResults[toolName]!.push(result);
  }

  /** Build a mock Client instance backed by this MCPMock. */
  buildClient(): object {
    const self = this;

    return {
      connect: async () => {
        self.connected = true;
      },
      close: async () => {
        self.connected = false;
      },
      listTools: async () => ({
        tools: self.tools,
      }),
      callTool: async (
        params: { name: string; arguments?: Record<string, unknown> },
      ) => {
        self.calls.push({ name: params.name, arguments: params.arguments ?? {} });

        const queue = self.toolResults[params.name];
        if (queue && queue.length > 0) {
          return queue.shift()!;
        }
        return {
          content: [{ type: 'text', text: `mock result for ${params.name}` }],
        };
      },
      ping: async () => {
        if (!self.connected) throw new Error('not connected');
      },
    };
  }

  /** Reset all recorded calls and scripted results. */
  reset(): void {
    this.calls = [];
    this.toolResults = {};
    this.connected = false;
  }
}
