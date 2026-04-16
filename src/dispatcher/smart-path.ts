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
import { buildManagerPrompt } from '../agent/system-prompt.js';
import {
  createMcpConnection,
  type McpConnection,
} from '../agent/mcp-connection.js';
import { extractEmailFromToken, extractSubFromToken } from '../auth/index.js';

const log = createChildLogger({ module: 'smart-path' });

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
  /** Dispatch mode: 'enclave' (default), 'dm', or 'provision'. */
  mode?: 'enclave' | 'dm' | 'provision';
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
      : input.enclaveName
        ? buildManagerPrompt({
            enclaveName: input.enclaveName,
            userSlackId: input.userSlackId,
            userEmail,
          })
        : buildDmSystemPrompt(userEmail);

  let mcp: McpConnection | null = null;
  try {
    mcp = await createMcpConnection(input.mcpUrl, input.userToken);
  } catch (err) {
    log.error({ err }, 'smart-path: MCP connection failed');
    // Fall through to tool-less mode — we can still answer conversationally.
  }

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
    tools: mcp?.tools ?? [],
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
            baseContext.tools = mcp.tools;
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

        // Auto-inject enclave when the tool's input schema accepts it.
        const args: Record<string, unknown> = {
          ...(toolCall.arguments as Record<string, unknown>),
        };
        if (
          input.enclaveName &&
          toolAcceptsEnclave(tool) &&
          args['enclave'] === undefined
        ) {
          args['enclave'] = input.enclaveName;
        }

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

    // If we exhausted MAX_TURNS without a terminal text response,
    // salvage text from any assistant message in the history so the
    // user at least sees the agent's partial thinking rather than
    // the generic fallback.
    if (!finalText) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') {
          const text = (
            m as { content: Array<{ type: string; text?: string }> }
          ).content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string)
            .join('')
            .trim();
          if (text) {
            log.warn(
              { turns: MAX_TURNS },
              'smart-path: MAX_TURNS reached, returning last assistant text',
            );
            finalText = text;
            break;
          }
        }
      }
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

function toolAcceptsEnclave(tool: { parameters: unknown }): boolean {
  const schema = tool.parameters as
    | { properties?: Record<string, unknown> }
    | undefined;
  return Boolean(schema?.properties && 'enclave' in schema.properties);
}

function buildDmSystemPrompt(userEmail: string): string {
  return [
    '# Role: The Kraken (DM mode)',
    '',
    'You are The Kraken, a conversational assistant for the Tentacular platform.',
    'The user is currently messaging you in a direct message (no enclave context).',
    `User email: ${userEmail}`,
    '',
    '## Response Style',
    '- Respond directly in first person. Never narrate your own actions.',
    '- Be concise and technical. Users are engineers.',
    '- If the user asks about workflows/tentacles, remind them those live inside enclave channels.',
  ].join('\n');
}

function buildProvisioningPrompt(
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
    '## Rules',
    '- Be conversational and concise. Users are engineers.',
    '- Do NOT ask for owner_email, owner_sub, channel_id, or platform — you already have those.',
    '- Only ask for name and description.',
    '- NEVER mention kubectl, namespace, or pod.',
  ].join('\n');
}
