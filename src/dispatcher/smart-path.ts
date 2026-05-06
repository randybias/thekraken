/**
 * Smart-path: inline dispatcher LLM + MCP tools, per D4.
 *
 * For enclave-bound mentions that aren't deterministic commands, the
 * dispatcher itself runs a minimal agent loop:
 *   1. Connect to MCP with the user's OIDC token → tool list.
 *   2. Call the LLM with manager system prompt + user message + tools.
 *   3. If toolUse, execute via MCP, append tool-result, loop.
 *   4. Return final assistant text.
 *
 * This bypasses the per-enclave team subprocess (which doesn't have a
 * pi/NDJSON bridge yet) and gives users a working smart path today.
 * The team model remains valid for longer-horizon work (code build,
 * deploy) — that's Phase 3/4.
 */

import {
  complete,
  getModel,
  registerBuiltInApiProviders,
  type Context,
  type Message,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';
import { createChildLogger } from '../logger.js';
import {
  createMcpConnection,
  type McpConnection,
} from '../agent/mcp-connection.js';
import { extractEmailFromToken, extractSubFromToken } from '../auth/index.js';

const log = createChildLogger({ module: 'smart-path' });

export type SmartPathMode = 'dm' | 'provision';

/**
 * Static per-mode allowlist of MCP tool names exposed to the LLM.
 *
 * The 2026-05-04 incident showed that exposing the entire MCP tool
 * catalog to a chat-only LLM lets it confabulate plus mutate cluster
 * state without the user's explicit consent. The allowlist is the
 * single source of truth for what the LLM can call. Mutations live
 * on the team-manager path (D2/D7) — never here.
 *
 * Spec: docs/superpowers/specs/2026-05-04-smart-path-tightening-design.md
 */
export const MODE_TOOL_ALLOWLIST: Record<
  SmartPathMode,
  ReadonlyArray<string>
> = {
  dm: ['enclave_list'],
  provision: ['enclave_provision'],
};

/**
 * Filter an MCP-advertised tool list down to the per-mode allowlist.
 * Pure function — no side effects, easy to test.
 */
export function filterToolsForMode<T extends { name: string }>(
  tools: ReadonlyArray<T>,
  mode: SmartPathMode,
): T[] {
  const allowed = MODE_TOOL_ALLOWLIST[mode];
  return tools.filter((t) => allowed.includes(t.name));
}

/** Maximum number of LLM ↔ tool turns per request. Guards against loops. */
const MAX_TURNS = 8;

// Ensure providers are registered once at module load.
let providersRegistered = false;
function ensureProviders(): void {
  if (providersRegistered) return;
  registerBuiltInApiProviders();
  providersRegistered = true;
}

export interface SmartPathInput {
  /** Full raw message text (will be cleaned of bot mention). */
  userMessage: string;
  /** Authenticated user's OIDC access token (D6). */
  userToken: string;
  /** Slack user ID. */
  userSlackId: string;
  /** Enclave name (null for DM / unbound). */
  enclaveName: string | null;
  /** MCP server URL. */
  mcpUrl: string;
  /** Anthropic API key. */
  anthropicApiKey: string;
  /** Model ID (e.g. 'claude-sonnet-4-6'). */
  modelId: string;
  /** Slack bot user ID — used to strip the leading mention. */
  botUserId?: string;
  /** Dispatch mode: 'dm' (DM with no enclave) or 'provision' (unbound channel). */
  mode: SmartPathMode;
  /** Slack channel ID — passed through for provisioning mode. */
  channelId?: string;
  /** Slack channel name — passed through for provisioning mode. */
  channelName?: string;
  /**
   * Prior turns in the same Slack thread, oldest first.
   * Used to give the LLM multi-turn conversational memory.
   * Each entry is the cleaned text (no mention prefix) plus who said it.
   */
  priorTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * Resolve a fresh, valid OIDC access token. Called at each tool-call
   * boundary so long-running agent loops survive Keycloak's short
   * (~5 minute) access-token TTL. The implementation should transparently
   * auto-refresh via the stored refresh_token.
   */
  getFreshToken?: () => Promise<string | null>;
}

/**
 * Run one smart-path turn and return the final assistant text.
 *
 * Returns null if the LLM produced no usable response (e.g., errored).
 */
export async function runSmartPath(
  input: SmartPathInput,
): Promise<string | null> {
  ensureProviders();

  const cleanedText = stripBotMention(input.userMessage, input.botUserId);
  if (!cleanedText.trim()) {
    return "Yes, I'm here. How can I help?";
  }

  const userEmail = extractEmailFromToken(input.userToken) ?? 'unknown';
  const userSub = extractSubFromToken(input.userToken) ?? 'unknown';
  const systemPrompt =
    input.mode === 'provision'
      ? buildProvisioningPrompt(
          userEmail,
          userSub,
          input.channelId ?? '',
          input.channelName ?? 'unknown-channel',
        )
      : buildDmSystemPrompt(userEmail);

  // Resolve a fresh token at entry. The caller's snapshot may be stale
  // (Keycloak access-token TTL ~5 min vs slow Slack delivery + background
  // refresh cadence). Falls back to the snapshot if getFreshToken errors
  // or returns null but the snapshot itself is non-empty.
  async function resolveTokenForEntry(): Promise<string | null> {
    if (input.getFreshToken) {
      try {
        const fresh = await input.getFreshToken();
        if (fresh) return fresh;
      } catch (err) {
        log.warn({ err }, 'smart-path: getFreshToken failed at entry');
      }
    }
    return input.userToken || null;
  }

  const REAUTH_MESSAGE =
    'Your session has expired. Please re-authenticate (DM me "login") and try again.';

  let activeToken = await resolveTokenForEntry();
  if (!activeToken) {
    log.error(
      'smart-path: no token available at entry — aborting with re-auth',
    );
    return REAUTH_MESSAGE;
  }

  let mcp: McpConnection | null = null;
  try {
    mcp = await createMcpConnection(input.mcpUrl, activeToken);
  } catch (err) {
    const status = (err as { code?: number }).code;
    if (status === 401) {
      log.warn(
        { err },
        'smart-path: 401 on initial MCP connect; retrying with fresh token',
      );
      const retryToken = input.getFreshToken
        ? await input.getFreshToken().catch(() => null)
        : null;
      if (!retryToken || retryToken === activeToken) {
        log.error(
          { err },
          'smart-path: persistent 401 — aborting with re-auth message',
        );
        return REAUTH_MESSAGE;
      }
      activeToken = retryToken;
      try {
        mcp = await createMcpConnection(input.mcpUrl, activeToken);
      } catch (err2) {
        log.error(
          { err: err2 },
          'smart-path: 401 persists after retry — aborting with re-auth message',
        );
        return REAUTH_MESSAGE;
      }
    } else {
      log.error(
        { err },
        'smart-path: MCP connection failed (non-401); falling through to tool-less',
      );
      // Non-auth errors keep the existing behavior — better to answer
      // conversationally than to drop the user.
    }
  }

  // Update the snapshot so the between-turns rotation compares against
  // the token we actually used (or are about to use).
  input.userToken = activeToken;

  const model = getModel('anthropic' as never, input.modelId as never);
  const messages: Message[] = [];
  // Thread memory: replay prior turns so follow-ups have context.
  for (const prior of input.priorTurns ?? []) {
    if (prior.role === 'user') {
      messages.push({
        role: 'user',
        content: prior.text,
        timestamp: Date.now(),
      });
    } else {
      // Store assistant turns as plain text so the LLM sees its prior replies.
      // We don't re-inflate tool calls — the LLM sees a conversational history.
      messages.push({
        role: 'user',
        content: `[Previous Kraken reply in this thread]: ${prior.text}`,
        timestamp: Date.now(),
      });
    }
  }
  messages.push({
    role: 'user',
    content: cleanedText,
    timestamp: Date.now(),
  });

  const baseContext: Context = {
    systemPrompt,
    messages,
    tools: filterToolsForMode(mcp?.tools ?? [], input.mode),
  };

  let finalText: string | null = null;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const assistant = await complete(model, baseContext, {
        apiKey: input.anthropicApiKey,
      });

      messages.push(assistant);

      const toolCalls = assistant.content.filter(
        (c): c is Extract<typeof c, { type: 'toolCall' }> =>
          c.type === 'toolCall',
      );

      if (toolCalls.length === 0 || assistant.stopReason !== 'toolUse') {
        // Terminal — collect final text
        const text = assistant.content
          .filter(
            (c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text',
          )
          .map((c) => c.text)
          .join('')
          .trim();
        finalText = text || null;
        if (assistant.stopReason === 'error') {
          log.warn(
            { errorMessage: assistant.errorMessage },
            'smart-path: LLM stopped with error',
          );
        }
        break;
      }

      // Refresh the MCP connection between turns if the token is about to
      // expire. Keycloak access tokens in eastus are ~5 min; long agent
      // loops (wf_run can take 60+s) outlive the original token. Calling
      // getFreshToken() pulls a refreshed token from the store.
      if (input.getFreshToken && mcp) {
        try {
          const fresh = await input.getFreshToken();
          if (fresh && fresh !== input.userToken) {
            log.debug(
              'smart-path: rotating MCP connection with refreshed token',
            );
            const oldMcp = mcp;
            mcp = await createMcpConnection(input.mcpUrl, fresh);
            baseContext.tools = filterToolsForMode(mcp.tools, input.mode);
            input.userToken = fresh;
            await oldMcp.close().catch(() => undefined);
          }
        } catch (err) {
          log.warn({ err }, 'smart-path: token refresh between turns failed');
        }
      }

      // Execute tool calls in sequence (keep order deterministic)
      const results: ToolResultMessage[] = [];
      for (const toolCall of toolCalls) {
        const tool = mcp?.tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          results.push({
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [
              {
                type: 'text',
                text: `Tool ${toolCall.name} is not available in this context.`,
              },
            ],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const args: Record<string, unknown> = {
          ...(toolCall.arguments as Record<string, unknown>),
        };

        try {
          const result = await tool.execute(
            toolCall.id,
            args as never,
            undefined,
          );
          results.push({
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError: false,
            timestamp: Date.now(),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            { tool: toolCall.name, err: msg },
            'smart-path: tool failed',
          );
          results.push({
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: 'text', text: `Error: ${msg}` }],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }

      messages.push(...results);
    }

    // MAX_TURNS exhausted without a terminal text response. Surface
    // the most recent tool error if one exists — replaying a stale
    // assistant utterance produced the misleading "Deployed. Now
    // triggering a manual run." message in the 2026-05-04 incident.
    if (!finalText) {
      const lastErr = findLastToolError(messages);
      if (lastErr) {
        const errText = lastErr.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('')
          .trim();
        finalText = `I couldn't complete this. The last tool I tried (\`${lastErr.toolName}\`) returned: ${truncate(errText, 500)}`;
      } else {
        finalText =
          "I ran out of steps trying to answer this and don't have a final result. Please re-ask, or @mention me in your enclave channel for a longer-running answer.";
      }
      log.warn(
        { turns: MAX_TURNS, hadToolError: Boolean(lastErr) },
        'smart-path: budget exhausted',
      );
    }
  } finally {
    if (mcp) await mcp.close().catch(() => undefined);
  }

  return finalText;
}

/** Strip leading `<@BOTID>` or `@kraken` mention from text. */
function stripBotMention(text: string, botUserId?: string): string {
  let s = text.trim();
  if (botUserId) {
    const re = new RegExp(`^<@${botUserId}>\\s*`, 'i');
    s = s.replace(re, '');
  }
  s = s.replace(/^<@[A-Z0-9_]+>\s*/i, '');
  s = s.replace(/^@kraken\s*/i, '');
  return s.trim();
}

export function buildDmSystemPrompt(userEmail: string): string {
  return [
    '# Role: The Kraken (DM mode)',
    '',
    `You are answering a direct message from ${userEmail}. You DO NOT`,
    "have access to any enclave's workflows, deployments, logs, or state.",
    'The only thing you can query is `enclave_list` — to remind the user',
    "which enclaves they're a member of.",
    '',
    '## What you can do',
    '- Answer general questions about Tentacular (concepts, scaffolds, skill).',
    "- List the user's enclaves and direct them to the right channel.",
    '- Help the user provision a new enclave (you will be re-prompted in',
    "  provision mode if they're in an unbound channel).",
    '',
    '## What you must NOT do',
    '- Claim anything about a specific workflow, deployment, run history,',
    '  log line, or status. You cannot see these in DM. If asked, say:',
    '  "Ask me from inside #<enclave-name> and I will answer with real data."',
    '- Invent telemetry, uptimes, run counts, error rates, or workflow',
    '  names. If you do not have a fact in front of you (from `enclave_list`',
    '  or the user message), it does not exist.',
    '',
    '## Prior thread context',
    'Earlier replies in this thread are shown to you for continuity. Do',
    'NOT treat your own prior replies as facts. If a prior reply mentioned',
    'specific telemetry, run history, or workflow state, that information',
    'is no longer available — restate only if the user re-asks and',
    'disclose you cannot verify.',
    '',
    '## Tool errors',
    'If a tool call returns an error, report the error verbatim and stop.',
    'Do not retry, do not invent a workaround, do not paper over.',
    '',
    '## Style',
    '- First person. Concise. Engineers reading.',
    '- If you do not know, say so.',
    '',
    '## Honesty about capabilities',
    'If you cannot do something, ask the user. NEVER claim a structural denial',
    '— e.g. "I don\'t have access to Slack" or "I can\'t retrieve that" —',
    'without first trying with the tools you have. If a tool call',
    'fails, say what failed and ask the user how to proceed.',
  ].join('\n');
}

export function buildProvisioningPrompt(
  userEmail: string,
  ownerSub: string,
  channelId: string,
  channelName: string,
): string {
  return [
    '# Role: The Kraken (Provisioning Mode)',
    '',
    'You are The Kraken, helping a user set up a new Tentacular enclave for their Slack channel.',
    `User email: ${userEmail}`,
    `Keycloak subject (owner_sub): ${ownerSub}`,
    `Slack channel ID: ${channelId}`,
    `Slack channel name: #${channelName}`,
    '',
    '## Provisioning Flow',
    'Walk the user through these steps conversationally:',
    '',
    `1. **Name**: Ask what the enclave should be called. Suggest \`${channelName}\` as the default.`,
    '   - Enclave names: lowercase, alphanumeric + hyphens, max 63 chars.',
    '   - If the user says "yes", "go ahead", or similar, use the channel name.',
    '2. **Description**: Ask for a brief description of what this enclave is for.',
    '3. **Provision**: Call the `enclave_provision` MCP tool with these exact parameters:',
    `   - name: (from step 1, default \`${channelName}\`)`,
    `   - owner_email: "${userEmail}"`,
    `   - owner_sub: "${ownerSub}"`,
    '   - platform: "slack"',
    `   - channel_id: "${channelId}"`,
    `   - channel_name: "${channelName}"`,
    '4. **Confirm**: On success, tell the user the enclave is ready and they can',
    '   start using it immediately (@Kraken in this channel).',
    '   On failure, report the error clearly.',
    '',
    '## Prior thread context',
    'Earlier replies in this thread are shown to you for continuity. Do',
    'NOT treat your own prior replies as facts. Continue the provisioning',
    'flow from wherever the user is now, not from what you previously',
    'claimed had happened.',
    '',
    '## Rules',
    '- Be conversational and concise. Users are engineers.',
    '- Do NOT ask for owner_email, owner_sub, channel_id, or platform — you already have those.',
    '- Only ask for name and description.',
    '- NEVER mention kubectl, namespace, or pod.',
    '',
    '## Honesty about capabilities',
    'If you cannot do something, ask the user. NEVER claim a structural denial',
    '— e.g. "I don\'t have access to Slack" or "I can\'t retrieve that" —',
    'without first trying with the tools you have. If a tool call',
    'fails, say what failed and ask the user how to proceed.',
  ].join('\n');
}

/**
 * Walk a message list in reverse, returning the most recent tool
 * result with isError === true, or null if none exist.
 *
 * Used by the MAX_TURNS bailout to surface a real tool error to the
 * user rather than replaying a stale assistant utterance.
 */
export function findLastToolError(
  messages: ReadonlyArray<unknown>,
): { toolName: string; content: Array<{ type: string; text: string }> } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | {
          role: string;
          toolName?: string;
          content?: unknown;
          isError?: boolean;
        }
      | undefined;
    if (m && m.role === 'toolResult' && m.isError === true) {
      return {
        toolName: String(m.toolName ?? 'unknown'),
        content: (m.content as Array<{ type: string; text: string }>) ?? [],
      };
    }
  }
  return null;
}

/** Truncate a string for safe inclusion in a user-facing message. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
