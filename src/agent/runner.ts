/**
 * Per-thread pi Agent lifecycle manager.
 *
 * Creates and manages pi Agent instances, one per Slack thread. Each agent
 * holds its own transcript (messages array) and is independent of other
 * threads. Agents are cleaned up after 7 days of inactivity.
 *
 * The runner uses ThreadQueue to ensure messages within the same thread
 * are processed serially. Messages across different threads are concurrent.
 *
 * Architecture note: we use Agent from pi-agent-core directly — NOT
 * AgentSession from pi-coding-agent — to avoid pulling in filesystem session
 * management, extension discovery, and interactive-mode concerns.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type Database from 'better-sqlite3';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ThreadQueue } from './queue.js';
import { injectContext } from './context-injector.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { McpConnection } from './mcp-connection.js';
import { createChildLogger } from '../logger.js';
import type { MessageContext } from '../types.js';

export type { MessageContext };

const log = createChildLogger({ module: 'agent-runner' });
const tracer = trace.getTracer('thekraken.agent');

/** Idle thread cleanup interval: 1 hour. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Idle thread expiry: 7 days. */
const IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AgentRunnerDeps {
  db: Database.Database;
  mcp: McpConnection;
  model: Model<any>;
  /**
   * Returns the API key for the given provider name.
   * Never logs the returned key.
   */
  getApiKey: (provider: string) => Promise<string | undefined>;
}

/**
 * Per-thread pi Agent lifecycle manager.
 */
export class AgentRunner {
  private agents = new Map<string, { agent: Agent; lastActive: number }>();
  private queue = new ThreadQueue();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private deps: AgentRunnerDeps;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
    this.cleanupTimer = setInterval(
      () => this.cleanupIdleThreads(),
      CLEANUP_INTERVAL_MS,
    );
    // Allow the process to exit even if the timer is pending
    this.cleanupTimer.unref?.();
  }

  /**
   * Handle an incoming message for a Slack thread.
   *
   * Queues messages for the same thread serially. Creates a pi Agent
   * on first message. Returns the agent's text response.
   *
   * @param threadKey - Unique thread identifier: "{channel_id}:{thread_ts}"
   * @param rawMessage - The user's message text (will have [CONTEXT] injected).
   * @param context - Message metadata for context injection.
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

  /** Returns true if there is an active agent for the given thread key. */
  hasThread(threadKey: string): boolean {
    return this.agents.has(threadKey);
  }

  /**
   * Graceful shutdown: drain the queue (wait for in-flight tasks), then
   * abort all active agents.
   */
  async shutdown(timeoutMs = 30000): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
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

        // Inject [CONTEXT] block before the user message
        const enrichedMessage = injectContext(rawMessage, {
          enclaveName: context.enclaveName,
          userEmail: 'unknown', // Phase 1 placeholder; Phase 2 resolves via OIDC
          slackUserId: context.slackUserId,
          mode: context.mode,
        });

        await entry.agent.prompt(enrichedMessage);

        // Extract text from the last assistant message in the transcript
        const messages = entry.agent.state.messages;
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');

        let responseText = '';
        if (lastAssistant && 'content' in lastAssistant) {
          const content = (lastAssistant as { content: unknown }).content;
          if (Array.isArray(content)) {
            responseText = content
              .filter(
                (c): c is { type: 'text'; text: string } =>
                  typeof c === 'object' &&
                  c !== null &&
                  'type' in c &&
                  c.type === 'text',
              )
              .map((c) => c.text)
              .join('');
          }
        }

        // Record GenAI span attributes (no prompt/response content — privacy)
        if (lastAssistant && 'usage' in lastAssistant) {
          const usage = (
            lastAssistant as { usage?: { input?: number; output?: number } }
          ).usage;
          if (usage) {
            span.setAttribute('gen_ai.system', this.deps.model.provider);
            span.setAttribute('gen_ai.request.model', this.deps.model.id);
            span.setAttribute('gen_ai.usage.input_tokens', usage.input ?? 0);
            span.setAttribute('gen_ai.usage.output_tokens', usage.output ?? 0);
          }
        }

        // Update thread session in SQLite
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
    _context: MessageContext,
  ): { agent: Agent; lastActive: number } {
    const existing = this.agents.get(threadKey);
    if (existing) return existing;

    // Check SQLite for a prior session in this thread
    const [channelId, threadTs] = threadKey.split(':');
    const row = this.deps.db
      .prepare(
        'SELECT session_id FROM thread_sessions WHERE channel_id = ? AND thread_ts = ?',
      )
      .get(channelId, threadTs) as { session_id: string } | undefined;

    // Build system prompt (placeholder layers for Phase 1)
    const systemPrompt = buildSystemPrompt({
      globalMemory: null, // Phase 1 placeholder — Phase 3 reads from git-state
      enclaveMemory: null, // Phase 1 placeholder — Phase 3 reads from git-state
      skills: null, // Phase 1 placeholder — Phase 3 injects skill docs
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.deps.model,
        tools: this.deps.mcp.tools,
        thinkingLevel: 'medium',
      },
      getApiKey: this.deps.getApiKey,
      toolExecution: 'sequential', // Avoids thundering herd on MCP server
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    });

    // Set thread key as session ID for Anthropic prompt caching
    agent.sessionId = threadKey;

    // Subscribe for structured logging on agent events
    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'agent_end') {
        log.debug(
          { threadKey, messageCount: event.messages.length },
          'agent turn ended',
        );
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
    // DM threads are not recorded in thread_sessions: the table has a FK on
    // enclave_name -> enclave_bindings.enclave_name, and DM sessions have no
    // enclave binding. Phase 2 may add a separate dm_sessions table if needed.
    if (context.mode === 'dm' || !context.enclaveName) return;

    const [channelId, threadTs] = threadKey.split(':');

    this.deps.db
      .prepare(
        `INSERT INTO thread_sessions
           (channel_id, thread_ts, session_id, user_slack_id, enclave_name, last_active_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
           last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        channelId,
        threadTs,
        threadKey, // session_id = thread key
        context.slackUserId,
        context.enclaveName,
      );
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
