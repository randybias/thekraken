# Phase 1: Core Loop — Design

**Change ID:** phase1-core-loop
**Status:** DRAFT
**Created:** 2026-04-13
**Author:** Senior Architect

---

## 0. Conventions

This document resolves all four PM-flagged ambiguities and provides exact
APIs developers copy-and-implement. Code blocks are authoritative. Prose
explains *why*; code blocks define *what*.

Phase 0 patterns carried forward:
- Conventional Commits on feature branch `feature/phase1-core-loop`
- Commit after each task group passes `npm test && npx tsc --noEmit`
- No code in `src/` without a corresponding test in `test/unit/`
- Multi-error throw pattern for config validation
- Express-compatible health handler composition

---

## 1. Pi Agent Integration Model (Ambiguity #1 — RESOLVED)

### Finding

After reading `pi-mono/packages/agent/src/agent.ts`, the `Agent` class is a
**per-instance stateful wrapper**. Each `new Agent(options)` holds its own:

- `_state: MutableAgentState` (system prompt, messages transcript, tools array,
  model, thinking level)
- `steeringQueue` and `followUpQueue` (PendingMessageQueue instances)
- `listeners` set (event subscribers)
- `activeRun` (abort controller + promise)

Key properties for our use case:

1. **Tools are per-instance.** `AgentOptions.initialState.tools` accepts an
   `AgentTool<any>[]`. Each Agent has its own tools array. There is no global
   tool registry.

2. **State is mutable at runtime.** `agent.state.tools = [...]` replaces the
   tools array (it's a setter that copies). System prompt, model, and thinking
   level are also mutable.

3. **Multiple Agents coexist.** Each Agent is an independent object with its
   own transcript and queues. The only shared state is the LLM provider's
   process-level HTTP connections (connection pooling in Node.js `fetch`).

4. **No session persistence built in.** `Agent` has no session ID concept
   for persistence (the `sessionId` field is forwarded to providers for
   cache-aware backends, not for state persistence). Our SQLite
   `thread_sessions` table handles persistence.

5. **Memory implications.** Each Agent holds its full transcript in
   `_state.messages[]`. For a 200k-token context window, a fully-loaded
   transcript is ~800KB of JSON. With 100 concurrent threads, that's ~80MB.
   Acceptable for a single-pod deployment. Idle cleanup (7-day prune)
   prevents unbounded growth.

### Resolution: Agent Factory Pattern

We do NOT need `pi-coding-agent`'s `createAgentSession()` -- that brings in
file-system session management, extension discovery, tool definitions (bash,
read, edit, write), and interactive-mode concerns we don't want. We use
`pi-agent-core`'s `Agent` directly.

`mcp-connection.ts` returns tool definitions (an `AgentTool[]`), not a
configured Agent. The `AgentRunner` constructs a fresh `Agent` per thread,
passing the MCP tools + system prompt.

```typescript
// src/agent/runner.ts — Agent factory (simplified signature)

import { Agent, type AgentOptions, type AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';

interface CreateAgentParams {
  model: Model<any>;
  tools: AgentTool[];
  systemPrompt: string;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

function createThreadAgent(params: CreateAgentParams): Agent {
  const options: AgentOptions = {
    initialState: {
      systemPrompt: params.systemPrompt,
      model: params.model,
      tools: params.tools,
      thinkingLevel: 'medium',
    },
    getApiKey: params.getApiKey,
    toolExecution: 'sequential',  // MCP tools are HTTP calls; sequential avoids thundering herd
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
  };
  return new Agent(options);
}
```

**Why `toolExecution: 'sequential'`:** MCP tools make HTTP calls to an
in-cluster server. Parallel execution of 5+ MCP calls in one turn risks
overwhelming the MCP server's request handler. Sequential execution is safer
for Phase 1; we can revisit in Phase 4 if latency is a concern.

**Why no `sessionId`:** Pi's `sessionId` is for cache-aware LLM providers
(e.g., Anthropic's prompt caching). We pass it as the thread key so Anthropic
can cache the system prompt across turns:

```typescript
const agent = createThreadAgent({ ... });
agent.sessionId = threadKey;  // e.g., "C012ABC:1712345678.123456"
```

---

## 2. Pi Extension Hook for [CONTEXT] Injection (Ambiguity #2 — RESOLVED)

### Finding

After reading `pi-mono/packages/coding-agent/src/core/extensions/types.ts`
(lines 858-879), the complete list of extension event names in pi-coding-agent
v0.66.1 is:

**Agent lifecycle:**
- `before_agent_start` — fired after user submits prompt, before agent loop
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`

**Tool lifecycle:**
- `tool_call` — fired before tool executes (can block)
- `tool_result` — fired after tool executes (can modify result)
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

**Context:**
- `context` — fired before each LLM call, can modify messages
- `before_provider_request` — fired before HTTP request to provider
- `input` — fired when user input received, before agent processing

**Session:**
- `session_start`, `session_shutdown`, `session_before_switch`,
  `session_before_fork`, `session_before_compact`, `session_compact`,
  `session_before_tree`, `session_tree`

**Other:**
- `resources_discover`, `model_select`, `user_bash`

### Resolution: We Do NOT Use Pi's Extension System

Critical realization: Pi's extension system (`ExtensionRunner`,
`discoverAndLoadExtensions`, `loadExtensionFromFactory`) lives in
`pi-coding-agent` and is tightly coupled to `AgentSession`, `SessionManager`,
`ModelRegistry`, and the interactive/RPC/print mode lifecycle. It requires:

1. An `ExtensionRunner` bound to a `SessionManager` and `ModelRegistry`
2. `bindCore()` called with `ExtensionActions` (sendMessage, appendEntry, etc.)
3. The runner to be wired into an `AgentSession` which calls
   `emitBeforeAgentStart()`, `emitContext()`, `emitToolCall()`, etc.

We are NOT using `AgentSession`. We are using `Agent` directly from
`pi-agent-core`. Therefore, we cannot use pi's extension event dispatch.

Instead, we use `Agent`'s native hooks which provide equivalent functionality:

| Design reference | Pi extension event | Agent hook equivalent |
|------------------|-------------------|----------------------|
| [CONTEXT] injection | `input` or `before_agent_start` | **Not needed.** We prepend the [CONTEXT] block to the user message before calling `agent.prompt()`. |
| Tool scoping (Phase 2) | `tool_call` (beforeToolCall) | `AgentOptions.beforeToolCall` callback |
| Jargon filter (Phase 3) | `tool_result` (afterToolCall) | `AgentOptions.afterToolCall` callback |
| Context transform | `context` | `AgentOptions.transformContext` callback |

**[CONTEXT] block injection is not an extension. It is inline code in the
agent runner.**

```typescript
// src/agent/context-injector.ts

export interface ContextParams {
  enclaveName: string | null;  // null for DM mode
  userEmail: string;           // "unknown" in Phase 1
  slackUserId: string;
  mode: 'enclave' | 'dm';
}

/**
 * Prepend [CONTEXT] block to user message text.
 * Format matches design Section 13.4 exactly.
 */
export function injectContext(message: string, params: ContextParams): string {
  const block = [
    '[CONTEXT]',
    `enclave: ${params.enclaveName ?? 'none'}`,
    `user_email: ${params.userEmail}`,
    `slack_user_id: ${params.slackUserId}`,
    `mode: ${params.mode}`,
    '[/CONTEXT]',
    '',
    message,
  ].join('\n');
  return block;
}
```

The runner calls `injectContext()` before `agent.prompt()`:

```typescript
// In AgentRunner.handleMessage():
const enrichedMessage = injectContext(rawMessage, {
  enclaveName: binding?.enclaveName ?? null,
  userEmail: 'unknown',  // Phase 1 placeholder; Phase 2 resolves from OIDC
  slackUserId,
  mode: binding ? 'enclave' : 'dm',
});
await agent.prompt(enrichedMessage);
```

**File rename:** `src/extensions/context-injector.ts` moves to
`src/agent/context-injector.ts`. It is a pure function, not a pi extension.
The `src/extensions/` directory retains `tool-scoping.ts` and
`jargon-filter.ts` as stubs for Phase 2/3.

---

## 3. Service Token Bootstrap (Ambiguity #3 — RESOLVED)

### Decision: Option (A) — Static Token from Environment Variable

**Why (A) over (B):**

1. **Phase 1 scope is minimal.** The MCP connection needs exactly one Bearer
   token. A `client_credentials` grant requires: Keycloak client
   configuration, token endpoint discovery, refresh scheduling, error
   handling for token expiry. That is 200+ LOC for a token that is replaced
   in Phase 2 anyway.

2. **Phase 2 does not "rip out" the env var.** The service token survives
   Phase 2 for Kraken-initiated MCP calls (consistency validation, health
   checks, enclave sync). Phase 2 adds per-user tokens for user-initiated
   calls. The `MCP_SERVICE_TOKEN` env var becomes the fallback, not the
   primary path.

3. **Complexity budget.** Phase 1 has 12 deliverables. Adding Keycloak
   `client_credentials` flow to the dependency chain increases blast radius.

**Bootstrap path:**

```
Helm Secret → env var MCP_SERVICE_TOKEN → createMcpConnection(url, token)
```

**Phase 2 migration path:**

```
Phase 1:  All MCP calls → service token
Phase 2:  User-initiated MCP calls → per-user OIDC token (from device flow)
          Kraken-initiated MCP calls → service token (unchanged)
Phase 3+: Service token optionally replaced with client_credentials grant
          (tracked as future followup, not Phase 2 scope)
```

**Security constraints (documented for T18):**
- `MCP_SERVICE_TOKEN` comes from a Kubernetes Secret, not a ConfigMap
- Never logged, never stored in SQLite, never included in error messages
- Never included in OTel span attributes
- Helm chart mounts it as `secretKeyRef`, not `configMapKeyRef`

**Config addition:**

```typescript
// Add to KrakenConfig (src/config.ts)
export interface McpConfig {
  url: string;
  port: number;
  serviceToken: string;  // NEW: from MCP_SERVICE_TOKEN env var
}
```

In `loadConfig()`:
```typescript
const mcpServiceToken = required('MCP_SERVICE_TOKEN');
```

---

## 4. Pino + Pi Logger Coexistence (Ambiguity #4 — RESOLVED)

### Finding

After searching `pi-mono/packages/agent/src/` and
`pi-mono/packages/coding-agent/src/core/` for any logger dependency:

- **pi-agent-core has no logger.** Zero imports of pino, winston, bunyan,
  or any logging library. No `console.log` calls in agent.ts or
  agent-loop.ts. The agent loop is pure event emission.

- **pi-coding-agent has no logger.** The coding-agent core uses
  `console.warn()` in exactly one place (extension shortcut conflict
  diagnostics, line 403 of runner.ts) and only when `!this.hasUI()`.

- **pi-ai has no logger.** Provider implementations use fetch directly.

### Resolution: Pino Is the Only Logger

There is no coexistence problem. Pi does not log. Pino is our application
logger and is the only logging system in the process.

```typescript
// src/logger.ts

import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;

/**
 * Create a child logger with contextual fields.
 * Use for module-level or request-level context.
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
```

Usage pattern:
```typescript
// In any module
import { createChildLogger } from '../logger.js';
const log = createChildLogger({ module: 'slack-bot' });

log.info({ event: 'app_mention', channel, threadTs }, 'received mention');
```

---

## 5. MCP HTTP Wrapper Exact Shape

### Transport Decision: StreamableHTTPClientTransport

The `@modelcontextprotocol/sdk` v1.29.0 provides
`StreamableHTTPClientTransport` for HTTP-based MCP connections. We use this
with custom headers for Bearer token injection.

```typescript
// src/agent/mcp-connection.ts

import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import { trace, SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Tool category constants (design Section 13.5)
// ---------------------------------------------------------------------------

/** Tools that auto-inject enclave namespace. */
export const ENCLAVE_SCOPED = [
  'wf_list', 'wf_describe', 'wf_status', 'wf_pods', 'wf_logs',
  'wf_events', 'wf_jobs', 'wf_health', 'wf_health_ns', 'wf_apply',
  'wf_run', 'wf_restart', 'wf_remove', 'permissions_get',
  'permissions_set', 'audit_rbac', 'audit_netpol', 'audit_psa',
  'enclave_info', 'enclave_sync',
] as const;

/** Tools blocked in enclave mode (DM or admin only). */
export const BLOCKED_IN_ENCLAVE = [
  'ns_create', 'enclave_provision', 'enclave_deprovision',
  'cluster_profile', 'cluster_preflight', 'proxy_status',
] as const;

/** Tools allowed in DM mode for cross-enclave reads. */
export const DM_ALLOWED = [
  'enclave_list',
] as const;

/** Cluster-wide read-only tools, no scoping needed. */
export const ALWAYS_ALLOWED = [
  'health_cluster_summary', 'health_nodes', 'health_ns_usage',
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
 * @param url - MCP server URL (e.g., "http://tentacular-mcp.tentacular-system:8080")
 * @param bearerToken - Service token (Phase 1) or user token (Phase 2)
 */
export async function createMcpConnection(
  url: string,
  bearerToken: string,
): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      },
    },
  );

  const client = new Client(
    { name: 'thekraken', version: '2.0.0' },
    { capabilities: { tools: {} } },
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
 * Wraps the call in an OTel span.
 */
function mcpToolToAgentTool(
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema?: unknown },
): AgentTool {
  // Build TypeBox schema from MCP's JSON Schema input
  // For Phase 1, we pass the raw JSON Schema as-is via Type.Unsafe()
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
        try {
          const result = await client.callTool(
            { name: mcpTool.name, arguments: params as Record<string, unknown> },
            undefined,
            { signal },
          );
          span.setAttribute('tool.status', 'ok');
          span.setAttribute('tool.duration_ms', Date.now() - start);
          span.setStatus({ code: SpanStatusCode.OK });

          const textContent = Array.isArray(result.content)
            ? result.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
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
```

---

## 6. Slack Bot Composition

### Dual-Mode Transport with Health Endpoint

```typescript
// src/slack/bot.ts

import { App, ExpressReceiver, type SlackEventMiddlewareArgs } from '@slack/bolt';
import { healthHandler, createHealthServer } from '../health.js';
import { createChildLogger } from '../logger.js';
import type { KrakenConfig } from '../config.js';
import type { AgentRunner } from '../agent/runner.js';
import type { EnclaveBindingEngine } from '../enclave/binding.js';
import type { OutboundTracker } from './outbound.js';
import type { Server } from 'node:http';

const log = createChildLogger({ module: 'slack-bot' });

export interface SlackBotDeps {
  config: KrakenConfig;
  runner: AgentRunner;
  bindings: EnclaveBindingEngine;
  outbound: OutboundTracker;
}

export interface SlackBot {
  app: App;
  /** Start receiving events. */
  start(): Promise<void>;
  /** Graceful shutdown: stop receiving, drain queues. */
  stop(): Promise<void>;
}

export function createSlackBot(deps: SlackBotDeps): SlackBot {
  const { config } = deps;
  let healthServer: Server | undefined;

  // --- Transport ---
  let app: App;

  if (config.slack.mode === 'http') {
    const receiver = new ExpressReceiver({
      signingSecret: config.slack.signingSecret!,
      endpoints: '/slack/events',
    });
    // Compose health endpoint on Bolt's Express router
    receiver.router.get('/healthz', healthHandler as any);

    app = new App({
      token: config.slack.botToken,
      receiver,
    });
  } else {
    app = new App({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      socketMode: true,
    });
    // Socket mode: Bolt doesn't start HTTP, so we run standalone health
    healthServer = createHealthServer(config.server.port);
  }

  // --- Event Handlers ---
  registerEventHandlers(app, deps);

  return {
    app,
    async start() {
      await app.start(config.slack.mode === 'http' ? config.server.port : undefined);
      log.info(
        { mode: config.slack.mode, port: config.server.port },
        'Slack bot started',
      );
    },
    async stop() {
      await app.stop();
      if (healthServer) {
        await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      }
      log.info('Slack bot stopped');
    },
  };
}

function registerEventHandlers(app: App, deps: SlackBotDeps): void {
  const { runner, bindings, outbound } = deps;

  app.event('app_mention', async ({ event, say }) => {
    // Ignore bot messages
    if ('bot_id' in event) return;

    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user;

    log.info({ channelId, threadTs, userId, event: 'app_mention' }, 'mention received');

    const binding = bindings.lookupEnclave(channelId);
    if (!binding) {
      log.debug({ channelId }, 'ignoring mention in unbound channel');
      return;
    }

    const response = await runner.handleMessage(
      `${channelId}:${threadTs}`,
      event.text,
      { enclaveName: binding.enclaveName, slackUserId: userId, mode: 'enclave' },
    );

    const result = await say({ text: response, thread_ts: threadTs });
    await outbound.store(channelId, threadTs, result.ts!, response);
  });

  app.event('message', async ({ event, say }) => {
    // Only handle thread replies and DMs
    if (event.subtype) return;
    if (!('user' in event)) return;
    if ('bot_id' in event) return;

    const channelId = event.channel;
    const threadTs = event.thread_ts;
    const userId = event.user;

    // DM handling
    if (event.channel_type === 'im') {
      const dmThreadTs = threadTs ?? event.ts;
      log.info({ channelId, threadTs: dmThreadTs, userId, event: 'dm' }, 'DM received');

      const response = await runner.handleMessage(
        `${channelId}:${dmThreadTs}`,
        event.text ?? '',
        { enclaveName: null, slackUserId: userId, mode: 'dm' },
      );

      const result = await say({ text: response, thread_ts: dmThreadTs });
      await outbound.store(channelId, dmThreadTs, result.ts!, response);
      return;
    }

    // Thread reply in enclave channel
    if (!threadTs) return;  // Top-level message without @mention — ignore

    const binding = bindings.lookupEnclave(channelId);
    if (!binding) return;

    // Only respond in threads where we already have a session
    const hasSession = runner.hasThread(`${channelId}:${threadTs}`);
    if (!hasSession) return;

    log.info({ channelId, threadTs, userId, event: 'thread_reply' }, 'thread reply');

    const response = await runner.handleMessage(
      `${channelId}:${threadTs}`,
      event.text ?? '',
      { enclaveName: binding.enclaveName, slackUserId: userId, mode: 'enclave' },
    );

    const result = await say({ text: response, thread_ts: threadTs });
    await outbound.store(channelId, threadTs, result.ts!, response);
  });
}
```

---

## 7. Per-Thread Queue Exact API

```typescript
// src/agent/queue.ts

type QueuedTask<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/**
 * Per-thread serial queue. Different threads run concurrently;
 * messages within the same thread run serially (FIFO).
 */
export class ThreadQueue {
  private queues = new Map<string, QueuedTask<unknown>[]>();
  private active = new Map<string, boolean>();
  private draining = false;

  /**
   * Enqueue a task for a specific thread. Returns a promise that
   * resolves with the task's return value.
   *
   * If the thread has no active task, executes immediately.
   * If the thread has an active task, queues for serial execution.
   */
  enqueue<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(new Error('Queue is draining; rejecting new tasks'));
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { fn, resolve, reject } as QueuedTask<T>;

      if (!this.queues.has(threadKey)) {
        this.queues.set(threadKey, []);
      }
      this.queues.get(threadKey)!.push(task as QueuedTask<unknown>);

      if (!this.active.get(threadKey)) {
        this.processNext(threadKey);
      }
    });
  }

  /**
   * Drain all queues. Waits for in-flight tasks to complete.
   * Rejects any new enqueue attempts. Resolves when all threads idle.
   *
   * @param timeoutMs - Maximum time to wait (default: 30000).
   */
  async drain(timeoutMs = 30000): Promise<void> {
    this.draining = true;

    const deadline = Date.now() + timeoutMs;
    while (this.hasActiveThreads()) {
      if (Date.now() > deadline) {
        throw new Error(`Queue drain timed out after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** True if any thread has an active or queued task. */
  hasActiveThreads(): boolean {
    for (const [, isActive] of this.active) {
      if (isActive) return true;
    }
    return false;
  }

  private async processNext(threadKey: string): Promise<void> {
    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) {
      this.active.set(threadKey, false);
      return;
    }

    this.active.set(threadKey, true);
    const task = queue.shift()!;

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }

    // Process next in same thread (tail call)
    this.processNext(threadKey);
  }
}
```

---

## 8. Agent Runner Exact API

```typescript
// src/agent/runner.ts

import { Agent, type AgentEvent, type AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type Database from 'better-sqlite3';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ThreadQueue } from './queue.js';
import { injectContext, type ContextParams } from './context-injector.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { McpConnection } from './mcp-connection.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'agent-runner' });
const tracer = trace.getTracer('thekraken.agent');

/** Idle thread cleanup interval: 1 hour. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Idle thread expiry: 7 days. */
const IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface MessageContext {
  enclaveName: string | null;
  slackUserId: string;
  mode: 'enclave' | 'dm';
}

export interface AgentRunnerDeps {
  db: Database.Database;
  mcp: McpConnection;
  model: Model<any>;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

export class AgentRunner {
  private agents = new Map<string, { agent: Agent; lastActive: number }>();
  private queue = new ThreadQueue();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private deps: AgentRunnerDeps;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
    this.cleanupTimer = setInterval(() => this.cleanupIdleThreads(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Handle an incoming message for a thread.
   * Queues serially per thread. Creates agent on first message.
   * Returns the agent's text response.
   */
  handleMessage(
    threadKey: string,
    rawMessage: string,
    context: MessageContext,
  ): Promise<string> {
    return this.queue.enqueue(threadKey, () =>
      this.processMessage(threadKey, rawMessage, context),
    );
  }

  /** Check if a thread has an active agent session. */
  hasThread(threadKey: string): boolean {
    return this.agents.has(threadKey);
  }

  /** Graceful shutdown: drain queue, abort active agents. */
  async shutdown(timeoutMs = 30000): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    await this.queue.drain(timeoutMs);
    for (const [, entry] of this.agents) {
      entry.agent.abort();
    }
    this.agents.clear();
  }

  private async processMessage(
    threadKey: string,
    rawMessage: string,
    context: MessageContext,
  ): Promise<string> {
    return tracer.startActiveSpan('agent.process_message', async (span) => {
      span.setAttribute('agent.thread_key', threadKey);
      span.setAttribute('enclave.name', context.enclaveName ?? 'dm');
      span.setAttribute('llm.provider', this.deps.model.provider);
      span.setAttribute('llm.model', this.deps.model.id);

      try {
        const entry = this.getOrCreateAgent(threadKey, context);

        const enrichedMessage = injectContext(rawMessage, {
          enclaveName: context.enclaveName,
          userEmail: 'unknown',  // Phase 1 placeholder
          slackUserId: context.slackUserId,
          mode: context.mode,
        });

        await entry.agent.prompt(enrichedMessage);

        // Extract text response from the last assistant message
        const messages = entry.agent.state.messages;
        const lastAssistant = [...messages].reverse().find(
          (m) => m.role === 'assistant',
        );

        let responseText = '';
        if (lastAssistant && 'content' in lastAssistant) {
          const content = (lastAssistant as any).content;
          if (Array.isArray(content)) {
            responseText = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
          }
        }

        // Record GenAI span attributes (no content — just metrics)
        if (lastAssistant && 'usage' in lastAssistant) {
          const usage = (lastAssistant as any).usage;
          span.setAttribute('gen_ai.system', this.deps.model.provider);
          span.setAttribute('gen_ai.request.model', this.deps.model.id);
          span.setAttribute('gen_ai.usage.input_tokens', usage?.input ?? 0);
          span.setAttribute('gen_ai.usage.output_tokens', usage?.output ?? 0);
        }

        // Update session tracking in SQLite
        this.recordSession(threadKey, context);

        entry.lastActive = Date.now();
        span.setStatus({ code: SpanStatusCode.OK });
        return responseText || '(no response)';
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error({ err, threadKey }, 'agent processing failed');
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private getOrCreateAgent(
    threadKey: string,
    context: MessageContext,
  ): { agent: Agent; lastActive: number } {
    const existing = this.agents.get(threadKey);
    if (existing) return existing;

    // Check SQLite for prior session in this thread
    const [channelId, threadTs] = threadKey.split(':');
    const row = this.deps.db
      .prepare(
        'SELECT session_id FROM thread_sessions WHERE channel_id = ? AND thread_ts = ?',
      )
      .get(channelId, threadTs) as { session_id: string } | undefined;

    // Build system prompt (placeholder layers for Phase 1)
    const systemPrompt = buildSystemPrompt({
      globalMemory: null,        // Phase 1 placeholder
      enclaveMemory: null,       // Phase 1 placeholder
      skills: null,              // Phase 1 placeholder
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.deps.model,
        tools: this.deps.mcp.tools,
        thinkingLevel: 'medium',
      },
      getApiKey: this.deps.getApiKey,
      toolExecution: 'sequential',
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    });

    // Use thread key as session ID for provider-side caching
    agent.sessionId = threadKey;

    // Subscribe to events for logging
    agent.subscribe(async (event: AgentEvent) => {
      if (event.type === 'agent_end') {
        log.debug({ threadKey, messageCount: event.messages.length }, 'agent turn ended');
      }
    });

    const entry = { agent, lastActive: Date.now() };
    this.agents.set(threadKey, entry);

    log.info(
      { threadKey, priorSession: row?.session_id ?? null },
      'created new agent for thread',
    );

    return entry;
  }

  private recordSession(threadKey: string, context: MessageContext): void {
    const [channelId, threadTs] = threadKey.split(':');
    const sessionId = threadKey;  // Use thread key as session ID

    this.deps.db
      .prepare(
        `INSERT INTO thread_sessions (channel_id, thread_ts, session_id, user_slack_id, enclave_name, last_active_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
           last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(channelId, threadTs, sessionId, context.slackUserId, context.enclaveName ?? 'dm');
  }

  private cleanupIdleThreads(): void {
    const cutoff = Date.now() - IDLE_EXPIRY_MS;
    let cleaned = 0;
    for (const [key, entry] of this.agents) {
      if (entry.lastActive < cutoff) {
        entry.agent.abort();
        this.agents.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info({ cleaned }, 'cleaned up idle agent threads');
    }
  }
}
```

---

## 9. OTel SDK Initialization

### Decision: Manual Spans Only (No Auto-Instrumentation)

**Why not `auto-instrumentations-node`:**

1. Auto-instrumentation patches `http`, `fetch`, `dns`, `net` at import time.
   In a Slack bot, every Bolt event handler, every Slack API call, and every
   MCP call gets auto-traced. This creates hundreds of spans per Slack event
   with minimal signal.

2. Pi's LLM streaming uses fetch internally. Auto-instrumenting fetch would
   create spans around every SSE chunk, polluting trace data.

3. Manual spans give us control over exactly what appears in SigNoz:
   Slack events, agent invocations, MCP tool calls, and GenAI metrics.

**Package versions (verified on npm 2026-04-13):**

```json
{
  "@opentelemetry/api": "^1.9.1",
  "@opentelemetry/sdk-node": "^0.214.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.214.0",
  "@opentelemetry/semantic-conventions": "^1.36.0",
  "@opentelemetry/resources": "^2.0.0"
}
```

Note: `@opentelemetry/instrumentation-http` from the PM's task list is NOT
included (per the manual-only decision). Remove from T01 dependency list.

```typescript
// src/telemetry.ts

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'telemetry' });

let sdk: NodeSDK | undefined;

/**
 * Initialize OpenTelemetry SDK. Call once at startup, before other imports
 * that might use the OTel API.
 *
 * If OTEL_EXPORTER_OTLP_ENDPOINT is empty or unset, OTel is disabled.
 * If the collector is unreachable, spans are dropped silently (no crash).
 */
export function initTelemetry(): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) {
    log.info('OTel disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set');
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'thekraken',
      [ATTR_SERVICE_VERSION]: '2.0.0',
    }),
    traceExporter: exporter,
  });

  try {
    sdk.start();
    log.info({ endpoint }, 'OTel SDK initialized');
  } catch (err) {
    log.warn({ err }, 'OTel SDK failed to start; continuing without telemetry');
    sdk = undefined;
  }
}

/**
 * Gracefully shutdown OTel SDK. Flushes pending spans.
 * Call during SIGTERM handling.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    log.info('OTel SDK shut down');
  } catch (err) {
    log.warn({ err }, 'OTel SDK shutdown error');
  }
}
```

---

## 10. Pi Extension Loading Mechanism

### How Pi Discovers Extensions (For Reference Only)

Pi v0.66.1 discovers extensions via:

1. **Project-local:** `cwd/.pi/extensions/*.ts` (auto-discovered)
2. **Global:** `~/.pi/agent/extensions/*.ts` (auto-discovered)
3. **Configured paths:** Passed to `discoverAndLoadExtensions(paths, cwd)`
4. **Package.json manifest:** `"pi": { "extensions": ["./src/ext.ts"] }`

Each extension is a TypeScript file exporting a factory function:
```typescript
export default function(api: ExtensionAPI): void | Promise<void> {
  api.on('tool_call', async (event, ctx) => { ... });
  api.registerTool({ name: 'foo', ... });
}
```

The factory receives an `ExtensionAPI` with `on()` for event subscription
and `registerTool()` for tool registration.

### Why We Do NOT Use This

As established in Section 2, we use `Agent` directly from `pi-agent-core`,
not `AgentSession` from `pi-coding-agent`. The extension system is part of
`pi-coding-agent` and requires `AgentSession` wiring.

Our equivalent hooks:
- `Agent.beforeToolCall` replaces `api.on('tool_call', ...)` (Phase 2)
- `Agent.afterToolCall` replaces `api.on('tool_result', ...)` (Phase 3)
- `Agent.transformContext` replaces `api.on('context', ...)` (if needed)
- Inline code before `agent.prompt()` replaces `api.on('input', ...)` and
  `api.on('before_agent_start', ...)`

Developers should NOT create files in `src/extensions/` that use pi's
`ExtensionAPI` or `ExtensionFactory` types. The stubs in that directory are
placeholders for Phase 2/3 code that will use `Agent` callbacks instead.

---

## 11. GenAI Span Attribute Conventions

Following the OpenTelemetry Semantic Conventions for Generative AI
(consistent with tentacular engine's existing OTel output):

| Attribute | Type | Description | Set Where |
|-----------|------|-------------|-----------|
| `gen_ai.system` | string | Provider name (e.g., "anthropic") | AgentRunner |
| `gen_ai.request.model` | string | Model ID (e.g., "claude-sonnet-4-6") | AgentRunner |
| `gen_ai.usage.input_tokens` | int | Input token count | AgentRunner |
| `gen_ai.usage.output_tokens` | int | Output token count | AgentRunner |
| `gen_ai.usage.total_tokens` | int | Total token count | AgentRunner |

**NOT included (security):**
- `gen_ai.prompt` — contains user messages (PII risk)
- `gen_ai.completion` — contains agent responses (PII risk)
- Any content from `[CONTEXT]` blocks

Additional Kraken-specific attributes:

| Attribute | Type | Description | Set Where |
|-----------|------|-------------|-----------|
| `enclave.name` | string | Enclave name or "dm" | AgentRunner |
| `agent.thread_key` | string | `{channel_id}:{thread_ts}` | AgentRunner |
| `tool.name` | string | MCP tool name | mcp-connection |
| `tool.status` | string | "ok" or "error" | mcp-connection |
| `tool.duration_ms` | int | MCP call duration | mcp-connection |
| `slack.event_type` | string | "app_mention", "message", "dm" | SlackBot |
| `slack.channel_id` | string | Channel ID | SlackBot |
| `slack.thread_ts` | string | Thread timestamp | SlackBot |

---

## 12. Helm `values.schema.json` vs `required()` (D11)

### Decision: `values.schema.json`

**Why `values.schema.json` over template-level `required()`:**

1. **Fail-fast at `helm install` time.** `values.schema.json` validates
   before rendering templates. `required()` fails during template rendering,
   which means partial template output and harder-to-read errors.

2. **Declarative.** The schema is a single JSON file that documents all
   required values, types, and constraints. It serves as documentation and
   validation in one artifact.

3. **Conditional requirements.** JSON Schema's `if/then/else` handles
   mode-conditional requirements (SLACK_SIGNING_SECRET required when http,
   SLACK_APP_TOKEN required when socket) more cleanly than template-level
   conditionals.

4. **IDE support.** JSON Schema provides autocomplete in editors when
   editing `values.yaml`.

**Location:** `charts/thekraken/values.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["slack", "oidc", "mcp"],
  "properties": {
    "slack": {
      "type": "object",
      "required": ["botToken"],
      "properties": {
        "botToken": {
          "type": "string",
          "minLength": 1,
          "description": "Slack bot OAuth token (xoxb-...)"
        },
        "mode": {
          "type": "string",
          "enum": ["http", "socket"],
          "default": "http"
        },
        "signingSecret": {
          "type": "string",
          "description": "Required when mode=http"
        },
        "appToken": {
          "type": "string",
          "description": "Required when mode=socket"
        }
      },
      "if": { "properties": { "mode": { "const": "http" } } },
      "then": { "required": ["signingSecret"] },
      "else": { "required": ["appToken"] }
    },
    "oidc": {
      "type": "object",
      "required": ["issuer", "clientId", "clientSecret"],
      "properties": {
        "issuer": { "type": "string", "minLength": 1 },
        "clientId": { "type": "string", "minLength": 1 },
        "clientSecret": { "type": "string", "minLength": 1 }
      }
    },
    "mcp": {
      "type": "object",
      "required": ["url", "serviceToken"],
      "properties": {
        "url": { "type": "string", "minLength": 1 },
        "serviceToken": { "type": "string", "minLength": 1 }
      }
    },
    "llm": {
      "type": "object",
      "description": "At least one API key must be set",
      "properties": {
        "anthropicApiKey": { "type": "string" },
        "openaiApiKey": { "type": "string" },
        "geminiApiKey": { "type": "string" }
      },
      "anyOf": [
        { "required": ["anthropicApiKey"] },
        { "required": ["openaiApiKey"] },
        { "required": ["geminiApiKey"] }
      ]
    },
    "otel": {
      "type": "object",
      "properties": {
        "endpoint": {
          "type": "string",
          "description": "OTLP HTTP endpoint (empty = disabled)"
        }
      }
    }
  }
}
```

---

## 13. Decisions Log

| # | Decision | Why |
|---|----------|-----|
| D1 | Use `Agent` from pi-agent-core directly, not `AgentSession` from pi-coding-agent | AgentSession brings filesystem sessions, extension runner, interactive mode — none needed for a Slack bot |
| D2 | Tools are per-instance on `Agent`, not global | Verified from source: `AgentOptions.initialState.tools` is an array owned by each Agent instance |
| D3 | No pi extension system | Extension events require `ExtensionRunner` + `AgentSession` wiring; we use `Agent` callbacks instead |
| D4 | [CONTEXT] injection is inline code, not a pi extension | Pure function called before `agent.prompt()`; moved to `src/agent/context-injector.ts` |
| D5 | `before_agent_start` is the closest pi hook for context injection, but we bypass it | We don't use the extension system; inline prepend achieves the same result |
| D6 | Static service token from env var (option A) | Minimal Phase 1 scope; env var survives Phase 2 as fallback for Kraken-initiated calls |
| D7 | Pino is the only logger | Pi agent-core and pi-ai have no logger; pi-coding-agent uses console.warn once |
| D8 | Manual OTel spans only, no auto-instrumentation | Auto-instrumentation creates noise from Slack Bolt internals and pi's streaming fetch |
| D9 | `@opentelemetry/instrumentation-http` removed from T01 | Consequence of D8; not needed |
| D10 | `toolExecution: 'sequential'` for MCP tools | Avoids thundering herd on MCP server; revisit in Phase 4 if latency matters |
| D11 | `values.schema.json` for Helm validation | Fail-fast, declarative, handles conditional requirements cleanly |
| D12 | `agent.sessionId = threadKey` for provider-side caching | Enables Anthropic prompt caching across turns in same thread |
| D13 | `MCP_SERVICE_TOKEN` from Kubernetes Secret, not ConfigMap | Security: token must not appear in ConfigMap (readable by default) |
| D14 | `src/extensions/context-injector.ts` moves to `src/agent/context-injector.ts` | It is a pure function, not a pi extension |
| D15 | OTel GenAI attributes match tentacular engine conventions | Consistent telemetry across the platform |
| D16 | No `gen_ai.prompt` or `gen_ai.completion` in spans | PII risk; security review requirement |

---

## 14. File Structure Delta (Phase 0 -> Phase 1)

```
src/
  index.ts                         REPLACE stub with full startup
  config.ts                        MODIFY  add MCP_SERVICE_TOKEN, LLM API keys, LOG_LEVEL, OTEL_*
  logger.ts                        NEW     pino logger
  telemetry.ts                     NEW     OTel SDK init/shutdown
  types.ts                         MODIFY  add EnclaveBinding, MessageContext types
  agent/
    runner.ts                      REPLACE stub with AgentRunner class
    queue.ts                       REPLACE stub with ThreadQueue class
    mcp-connection.ts              NEW     MCP HTTP wrapper + tool conversion
    system-prompt.ts               REPLACE stub with buildSystemPrompt()
    context-injector.ts            NEW     [CONTEXT] block injection (moved from extensions/)
    tools.ts                       KEEP    stub (Phase 2: tool scoping config)
  slack/
    bot.ts                         REPLACE stub with createSlackBot()
    outbound.ts                    NEW     outbound message tracking
  enclave/
    binding.ts                     REPLACE stub with lookupEnclave()
  extensions/
    context-injector.ts            DELETE  (moved to agent/)
    tool-scoping.ts                KEEP    stub (Phase 2)
    jargon-filter.ts               KEEP    stub (Phase 3)
charts/thekraken/
  values.schema.json               NEW     Helm validation schema
  templates/networkpolicy.yaml     MODIFY  add OTel egress rule
  values.yaml                      MODIFY  add otel, llm, mcp.serviceToken sections
```

---

## 15. Startup Sequence (src/index.ts)

```typescript
// src/index.ts

import { loadConfig } from './config.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './logger.js';
import { initDatabase } from './db/index.js';
import { createMcpConnection } from './agent/mcp-connection.js';
import { AgentRunner } from './agent/runner.js';
import { createSlackBot } from './slack/bot.js';
import { EnclaveBindingEngine } from './enclave/binding.js';
import { OutboundTracker } from './slack/outbound.js';

async function main(): Promise<void> {
  // 1. Load config (fails fast with all missing vars)
  const config = loadConfig();

  // 2. Initialize OTel (before anything else creates spans)
  initTelemetry();

  // 3. Initialize SQLite
  const db = initDatabase(config);

  // 4. Create MCP connection
  const mcp = await createMcpConnection(config.mcp.url, config.mcp.serviceToken);

  // 5. Resolve LLM model
  const model = resolveModel(config);

  // 6. Create subsystems
  const bindings = new EnclaveBindingEngine(db);
  const outbound = new OutboundTracker(db);
  const runner = new AgentRunner({
    db,
    mcp,
    model,
    getApiKey: (provider) => resolveApiKey(config, provider),
  });

  // 7. Create and start Slack bot
  const bot = createSlackBot({ config, runner, bindings, outbound });
  await bot.start();

  // 8. Log startup banner
  const enclaveCount = bindings.count();
  logger.info({
    version: '2.0.0',
    mode: config.slack.mode,
    mcpUrl: config.mcp.url,
    enclaves: enclaveCount,
  }, 'The Kraken v2 started');

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await bot.stop();
    await runner.shutdown();
    await mcp.close();
    db.close();
    await shutdownTelemetry();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
```

---

## 16. New Ambiguities for Developer Awareness

### A1: MCP Tool Schema Fidelity

The MCP SDK returns tool schemas as JSON Schema objects. Pi's `AgentTool`
expects TypeBox schemas (`TSchema`). In Section 5, we use `Type.Unsafe()`
to pass JSON Schema through TypeBox's type system without conversion. This
works for tool execution (pi validates with the raw schema) but TypeBox's
compile-time type inference will be `Record<string, unknown>` for all MCP
tools. This is acceptable for Phase 1 (MCP tools are dynamically discovered)
but may need a schema-generation step in Phase 4 if we want compile-time
type safety on specific tool arguments.

### A2: Outbound Message Dedup vs Thread Resumption

After a pod restart, `hasOutboundInThread()` prevents re-sending. But if a
user messages in a thread where the Agent state was lost (in-memory only),
the Agent starts fresh with no conversation history. The user sees a coherent
thread in Slack, but the Agent has amnesia. Phase 2 should evaluate whether
to persist Agent transcripts to SQLite or accept the restart-amnesia tradeoff.

### A3: Model Resolution from Config

The `resolveModel()` function in Section 15 is not defined. It must map
`config.llm.defaultProvider` + `config.llm.defaultModel` to a pi `Model<any>`
object. Pi's `ModelRegistry` has built-in model definitions, but we're not
using `pi-coding-agent`'s registry. The developer needs to construct the
`Model` object manually from pi-ai's model definitions or hardcode the
defaults. This is a T10 implementation detail.
