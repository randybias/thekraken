/**
 * MCP HTTP wrapper — thin custom transport layer (~100 LOC) on top of
 * @modelcontextprotocol/sdk. Wraps each tool call in an OTel span.
 *
 * Design decisions:
 * - All MCP calls carry the authenticated user's OIDC access token (D6)
 * - No community adapter — we control the HTTP layer directly
 * - All registered MCP tools exposed in pi-Agent-consumable format
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { trace, SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Tool category constants (design Section 13.5)
// ---------------------------------------------------------------------------

/** Tools that auto-inject enclave name. Phase 2 adds enforcement. */
export const ENCLAVE_SCOPED = [
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
  'audit_rbac',
  'audit_netpol',
  'audit_psa',
  'enclave_info',
  'enclave_sync',
] as const;

/** Tools blocked in enclave mode (DM or admin only). Phase 2 adds enforcement. */
export const BLOCKED_IN_ENCLAVE = [
  'enclave_provision',
  'enclave_deprovision',
  'enclave_preflight',
  'cluster_profile',
  'proxy_status',
] as const;

/** Tools allowed in DM mode for cross-enclave reads. */
export const DM_ALLOWED = ['enclave_list'] as const;

/** Cluster-wide read-only tools, no scoping needed. */
export const ALWAYS_ALLOWED = [
  'health_cluster_summary',
  'health_nodes',
  'health_enclave_usage',
] as const;

/** All registered tool names. */
export const ALL_MCP_TOOLS = [
  ...ENCLAVE_SCOPED,
  ...BLOCKED_IN_ENCLAVE,
  ...DM_ALLOWED,
  ...ALWAYS_ALLOWED,
] as const;

export type McpToolCategory =
  | 'ENCLAVE_SCOPED'
  | 'BLOCKED_IN_ENCLAVE'
  | 'DM_ALLOWED'
  | 'ALWAYS_ALLOWED';

export type McpToolName = (typeof ALL_MCP_TOOLS)[number];

// ---------------------------------------------------------------------------
// MCP Connection
// ---------------------------------------------------------------------------

export interface McpConnection {
  /** The underlying MCP client. */
  client: Client;
  /** Pi-compatible tool definitions for all registered MCP tools. */
  tools: AgentTool[];
  /** Check if the MCP server is reachable. */
  healthCheck(): Promise<boolean>;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Create an MCP client connection to the Tentacular MCP server.
 *
 * Returns pi-Agent-compatible tool definitions derived from the MCP
 * server's tool list. Phase 1 registers all tools; Phase 2 adds
 * enforcement via beforeToolCall.
 *
 * The user's OIDC access token is passed in the standard HTTP Authorization
 * header. It must NEVER be logged, stored in SQLite, or included in OTel
 * span attributes.
 *
 * @param url - MCP server URL (e.g., "http://tentacular-mcp.tentacular-system:8080")
 * @param userAccessToken - The authenticated user's OIDC access token (D6).
 */
export async function createMcpConnection(
  url: string,
  userAccessToken: string,
): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
      },
    },
  });

  const client = new Client(
    { name: 'thekraken', version: '0.9.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  // Discover tools from server
  const serverTools = await client.listTools();
  const knownTools = new Set<string>(ALL_MCP_TOOLS);

  // Convert MCP tool definitions to pi AgentTool format
  const tools: AgentTool[] = serverTools.tools
    .filter((t) => knownTools.has(t.name))
    .map((mcpTool) => mcpToolToAgentTool(client, mcpTool));

  return {
    client,
    tools,
    async healthCheck(): Promise<boolean> {
      try {
        await client.ping();
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

const tracer = trace.getTracer('thekraken.mcp');

/**
 * Convert a single MCP tool definition to a pi AgentTool.
 * Wraps the call in an OTel span with non-PII attributes only.
 */
function mcpToolToAgentTool(
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema?: unknown },
): AgentTool {
  // Build TypeBox schema from MCP's JSON Schema input.
  // Type.Unsafe() passes JSON Schema through TypeBox's type system without
  // conversion. This gives correct runtime validation at the cost of
  // compile-time inference being Record<string, unknown> for all MCP tools.
  // Phase 4 can add generated TypeBox schemas for type safety.
  const parameters = Type.Unsafe<Record<string, unknown>>(
    (mcpTool.inputSchema as object) ?? { type: 'object', properties: {} },
  );

  return {
    name: mcpTool.name,
    label: mcpTool.name.replace(/_/g, ' '),
    description: mcpTool.description ?? '',
    parameters,
    async execute(toolCallId, params, signal) {
      return tracer.startActiveSpan(`mcp.${mcpTool.name}`, async (span) => {
        const start = Date.now();
        span.setAttribute('tool.name', mcpTool.name);
        // tool.call_id is safe (internal, no user data)
        span.setAttribute('tool.call_id', toolCallId);
        try {
          const result = await client.callTool(
            {
              name: mcpTool.name,
              arguments: params as Record<string, unknown>,
            },
            undefined,
            { signal },
          );
          span.setAttribute('tool.status', 'ok');
          span.setAttribute('tool.duration_ms', Date.now() - start);
          span.setStatus({ code: SpanStatusCode.OK });

          const textContent = Array.isArray(result.content)
            ? result.content
                .filter(
                  (c): c is { type: 'text'; text: string } => c.type === 'text',
                )
                .map((c) => c.text)
                .join('\n')
            : String(result.content ?? '');

          return {
            content: [{ type: 'text' as const, text: textContent }],
            details: result,
          };
        } catch (err) {
          span.setAttribute('tool.status', 'error');
          span.setAttribute('tool.duration_ms', Date.now() - start);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };
}
