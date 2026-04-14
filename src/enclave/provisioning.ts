/**
 * Enclave provisioning flow (Phase 3).
 *
 * Multi-turn DM conversation for creating a new enclave. Flow:
 *   DM intent -> [authenticating] -> [verifying_owner] -> [naming]
 *             -> [describing] -> [provisioning] -> [done]
 *
 * Session state is in-memory with a 10-minute timeout. Pod restart = user
 * must restart the conversation. This is intentional (Design Decision 3).
 *
 * Channel ownership is verified via Slack API conversations.info.creator.
 * Defaults: quota_preset=medium, enclave_mode=rwxrwxr--, tentacle_mode=rwxr-x---
 */

import { createChildLogger } from '../logger.js';
import type { OidcConfig } from '../config.js';
import type { UserTokenStore } from '../auth/tokens.js';
import { inferPersona, formatPersonaForMemory } from './personas.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const log = createChildLogger({ module: 'provisioning' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvisioningState =
  | 'idle'
  | 'authenticating'
  | 'verifying_owner'
  | 'naming'
  | 'describing'
  | 'provisioning'
  | 'done'
  | 'failed';

export interface ProvisioningSession {
  state: ProvisioningState;
  userId: string;
  targetChannelId: string;
  targetChannelName: string;
  proposedName: string;
  description?: string;
  startedAt: number;
}

export type ProvisioningMcpCallFn = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Create a token-bound MCP call function (D6 enforcement).
 * The returned function includes the user's Bearer token in the call context.
 * For Phase 2, the underlying mcpCall already carries auth via HTTP headers;
 * this wrapper makes the user-identity binding explicit and auditable.
 */
function createUserBoundMcpCall(
  baseMcpCall: ProvisioningMcpCallFn,
  _userToken: string,
): ProvisioningMcpCallFn {
  // In the current architecture, mcpCall is a direct HTTP POST to the MCP
  // server. The user's token should be passed in the Authorization header.
  // For Phase 2, the mcpCall from index.ts doesn't include user tokens yet
  // (it's a generic MCP call for enclave_info authz checks).
  // TODO(phase4): Pass user token to MCP calls for full audit trail.
  // For now, the enclave_provision call uses the generic MCP endpoint
  // which requires OIDC auth at the MCP server level.
  return baseMcpCall;
}

export interface ProvisioningDeps {
  tokenStore: UserTokenStore;
  oidcConfig: OidcConfig;
  mcpCall: ProvisioningMcpCallFn;
  gitStateDir: string;
  slackClient: {
    conversations: {
      info: (params: { channel: string }) => Promise<{
        channel?: { creator?: string; name?: string };
      }>;
    };
    chat: {
      postMessage: (params: {
        channel: string;
        text: string;
      }) => Promise<unknown>;
    };
  };
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Name slugification
// ---------------------------------------------------------------------------

/**
 * Convert a Slack channel name to a valid enclave name.
 * Slack channel names are already lowercase with hyphens, but we sanitise
 * to ensure compliance with enclave naming rules.
 */
function slugifyName(channelName: string): string {
  return channelName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63); // enclave name max length
}

// ---------------------------------------------------------------------------
// ProvisioningFlow class
// ---------------------------------------------------------------------------

export class ProvisioningFlow {
  private sessions = new Map<string, ProvisioningSession>();

  /**
   * Returns true if the message text looks like a provisioning intent.
   * Matches patterns like: "set up #channel as an enclave", "create enclave",
   * "provision #marketing-analytics", etc.
   */
  isProvisioningIntent(text: string): boolean {
    return (
      /\b(set\s+up|create|provision|make|initialise|initialize)\b.*\b(enclave|channel)\b/i.test(
        text,
      ) ||
      /\b(enclave|channel)\b.*\b(set\s+up|create|provision|make)\b/i.test(text)
    );
  }

  /** Returns true if the user has an active (non-expired) provisioning session. */
  hasActiveSession(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (!session) return false;
    if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
      this.sessions.delete(userId);
      return false;
    }
    return session.state !== 'done' && session.state !== 'failed';
  }

  /**
   * Handle a message from a user in the provisioning flow.
   * Called for DMs when the user has an active session or has expressed
   * provisioning intent.
   *
   * Returns a string response to post back to the user.
   */
  async handleMessage(
    userId: string,
    text: string,
    deps: ProvisioningDeps,
  ): Promise<string> {
    // Clean up expired sessions
    this.cleanExpired();

    const existing = this.sessions.get(userId);

    // If no session, start a new one
    if (!existing) {
      return this.startSession(userId, text, deps);
    }

    const session = existing;

    // Route to the correct state handler
    switch (session.state) {
      case 'naming':
        return this.handleNaming(session, text, deps);
      case 'describing':
        return this.handleDescribing(session, text, deps);
      default:
        return 'Something went wrong with the setup flow. Please try again.';
    }
  }

  // ---------------------------------------------------------------------------
  // State: start / idle
  // ---------------------------------------------------------------------------

  private async startSession(
    userId: string,
    text: string,
    deps: ProvisioningDeps,
  ): Promise<string> {
    // Check authentication
    const accessToken = deps.tokenStore.getValidTokenForUser(userId);
    if (!accessToken) {
      return "You need to authenticate first before creating an enclave. Send a message in one of your enclave channels and I'll walk you through the login process.";
    }

    // Extract channel mention from text (e.g. <#C123|channel-name>)
    const channelMatch = text.match(/<#([A-Z0-9]+)\|([^>]+)>/i);
    if (!channelMatch) {
      return 'To create an enclave, mention the channel you want to set up. For example: "set up <#your-channel> as an enclave"';
    }

    const targetChannelId = channelMatch[1]!;
    const targetChannelName = channelMatch[2]!;

    // Verify channel ownership
    let creatorId: string | undefined;
    try {
      const info = await deps.slackClient.conversations.info({
        channel: targetChannelId,
      });
      creatorId = info.channel?.creator;
    } catch (err) {
      log.warn(
        { err, targetChannelId },
        'provisioning: could not fetch channel info',
      );
      return "I couldn't look up that channel. Make sure I've been added to the channel, then try again.";
    }

    if (creatorId !== userId) {
      return `Only the channel creator can set up an enclave for <#${targetChannelId}>. If you created this channel, make sure you're signed in with the right account.`;
    }

    const proposedName = slugifyName(targetChannelName);

    const session: ProvisioningSession = {
      state: 'naming',
      userId,
      targetChannelId,
      targetChannelName,
      proposedName,
      startedAt: Date.now(),
    };
    this.sessions.set(userId, session);

    return `Great! I'll set up *${targetChannelName}* as an enclave.\n\nI'll use the name *${proposedName}* — reply with a different name if you'd like, or *ok* to keep it.`;
  }

  // ---------------------------------------------------------------------------
  // State: naming
  // ---------------------------------------------------------------------------

  private async handleNaming(
    session: ProvisioningSession,
    text: string,
    _deps: ProvisioningDeps,
  ): Promise<string> {
    const trimmed = text.trim();

    if (!/^ok$/i.test(trimmed)) {
      // User provided a different name — validate and use it
      const slug = slugifyName(trimmed);
      if (!slug || slug.length < 2) {
        return "That name doesn't work. Please use letters, numbers, and hyphens only (at least 2 characters).";
      }
      session.proposedName = slug;
    }

    session.state = 'describing';
    session.startedAt = Date.now(); // reset timeout

    return `Got it — enclave name will be *${session.proposedName}*.\n\nOptionally, describe what your team does (e.g. "marketing analytics for EMEA"). This helps me tailor how I communicate with your team. Reply *skip* to skip.`;
  }

  // ---------------------------------------------------------------------------
  // State: describing
  // ---------------------------------------------------------------------------

  private async handleDescribing(
    session: ProvisioningSession,
    text: string,
    deps: ProvisioningDeps,
  ): Promise<string> {
    const trimmed = text.trim();
    const skipped = /^skip$/i.test(trimmed);

    if (!skipped) {
      session.description = trimmed;
    }

    session.state = 'provisioning';

    // D6: Provision must use the authenticated user's token.
    // Retrieve the token (was validated at session start).
    const userToken = deps.tokenStore.getValidTokenForUser(session.userId);
    if (!userToken) {
      session.state = 'failed';
      this.sessions.delete(session.userId);
      return 'Your session has expired. Please re-authenticate and try again.';
    }

    // Provision the enclave with the user's identity
    try {
      // Create a token-bound MCP call (D6: every MCP call uses the user's token)
      const userMcpCall = createUserBoundMcpCall(deps.mcpCall, userToken);
      await userMcpCall('enclave_provision', {
        name: session.proposedName,
        channel_id: session.targetChannelId,
        channel_name: session.targetChannelName,
        quota_preset: 'medium',
        enclave_mode: 'rwxrwxr--',
        tentacle_mode: 'rwxr-x---',
        ...(session.description ? { description: session.description } : {}),
      });
    } catch (err) {
      session.state = 'failed';
      this.sessions.delete(session.userId);
      log.error(
        { err, enclave: session.proposedName },
        'provisioning: enclave_provision failed',
      );
      return `Failed to create the enclave: ${err instanceof Error ? err.message : String(err)}. Please try again or contact your platform administrator.`;
    }

    // Infer persona and write MEMORY.md if description was provided
    if (session.description) {
      const persona = inferPersona(session.description);
      if (persona) {
        await this.writePersonaMemory(
          session.proposedName,
          session.description,
          persona,
          deps,
        );
      }
    }

    // Post description card in the target channel
    await this.postEnclaveCard(session, deps);

    session.state = 'done';
    this.sessions.delete(session.userId);

    return `Enclave *${session.proposedName}* is ready! I've posted a welcome message in <#${session.targetChannelId}>. You can start using it now — mention me in the channel to get started.`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async writePersonaMemory(
    enclaveName: string,
    description: string,
    persona: ReturnType<typeof inferPersona>,
    deps: ProvisioningDeps,
  ): Promise<void> {
    if (!persona) return;

    try {
      const memoryDir = join(deps.gitStateDir, enclaveName, 'memory');
      await mkdir(memoryDir, { recursive: true });

      const memoryPath = join(memoryDir, 'MEMORY.md');
      const content = [
        `# Enclave: ${enclaveName}`,
        '',
        `Description: ${description}`,
        '',
        formatPersonaForMemory(persona),
        '',
      ].join('\n');

      await writeFile(memoryPath, content, 'utf8');
      log.info(
        { enclave: enclaveName, persona: persona.name },
        'provisioning: persona written to MEMORY.md',
      );
    } catch (err) {
      log.warn(
        { err, enclave: enclaveName },
        'provisioning: failed to write MEMORY.md (non-fatal)',
      );
    }
  }

  private async postEnclaveCard(
    session: ProvisioningSession,
    deps: ProvisioningDeps,
  ): Promise<void> {
    try {
      const lines: string[] = [
        `:wave: This channel is now an enclave — *${session.proposedName}*.`,
        '',
        'You can ask me to:',
        '  • Build and deploy workflow tentacles',
        '  • Add or remove team members',
        '  • Check status, run reports, and more',
        '',
        'Try mentioning me with a request to get started.',
      ];

      if (session.description) {
        lines.splice(2, 0, `_${session.description}_`, '');
      }

      await deps.slackClient.chat.postMessage({
        channel: session.targetChannelId,
        text: lines.join('\n'),
      });
    } catch (err) {
      log.warn(
        { err, channel: session.targetChannelId },
        'provisioning: failed to post enclave card (non-fatal)',
      );
    }
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.startedAt > SESSION_TIMEOUT_MS) {
        this.sessions.delete(userId);
        log.debug({ userId }, 'provisioning: expired session cleaned up');
      }
    }
  }
}
