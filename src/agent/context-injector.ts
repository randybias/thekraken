/**
 * [CONTEXT] block injector for The Kraken v2.
 *
 * Prepends a structured [CONTEXT] block to every user message before
 * calling agent.prompt(). This is NOT a pi extension — it is inline code
 * called directly in the AgentRunner.
 *
 * Design rationale (Section 2, design.md):
 * Pi's extension system requires AgentSession wiring from pi-coding-agent,
 * which we do not use. The [CONTEXT] block is injected as inline code
 * before agent.prompt() — equivalent to the pi `before_agent_start` hook
 * but without the extension machinery.
 *
 * Format (Section 13.4):
 *   [CONTEXT]
 *   enclave: <name or "none">
 *   user_email: <email or "unknown">
 *   slack_user_id: <slack user ID>
 *   mode: <"enclave" or "dm">
 *   [/CONTEXT]
 *
 *   <original message>
 */

export interface ContextParams {
  /** Enclave name in enclave mode; null in DM mode. */
  enclaveName: string | null;
  /**
   * User email address. "unknown" in Phase 1 (OIDC not yet wired).
   * Phase 2 resolves this from the per-user OIDC token.
   */
  userEmail: string;
  /** Slack user ID of the message sender (e.g. "U012ABC"). */
  slackUserId: string;
  /** Message mode — enclave channel or direct message. */
  mode: 'enclave' | 'dm';
}

/**
 * Prepend a [CONTEXT] block to a user message.
 *
 * @param message - The original user message text.
 * @param params - Context parameters for this message.
 * @returns The message with [CONTEXT] block prepended.
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
