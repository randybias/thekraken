/**
 * Dispatcher auth gate — runs before team dispatch.
 *
 * Wire order (design section 7.3):
 *   1. getValidTokenForUser() -> null = unauthenticated (trigger auth card)
 *   2. extractEmailFromToken() -> empty = unauthenticated
 *   3. classifyOperation() -> read | write | execute
 *   4. checkAccess() -> denied = return denial
 *   5. Pass: return token + email + role for mailbox record
 *
 * Per D6: No service tokens, no fallbacks. Token expired = fail + re-auth.
 *
 * classifyOperation uses simple keyword regex (design A2). Default is read
 * (least restrictive for ambiguous messages). The MCP server enforces its
 * own authz as defense in depth.
 */

import type { OidcConfig } from '../config.js';
import { extractEmailFromToken } from '../auth/refresh.js';
import type { UserTokenStore } from '../auth/tokens.js';
import { checkAccess, type Role, type Operation } from '../enclave/authz.js';

// ---------------------------------------------------------------------------
// Operation classification
// ---------------------------------------------------------------------------

/**
 * Classify a user message as read, write, or execute.
 *
 * Default: read (least restrictive for ambiguous messages).
 * The MCP server enforces its own authz as defense in depth.
 */
export function classifyOperation(text: string): Operation {
  const lower = text.toLowerCase();

  // Execute: running/triggering tentacles
  if (/\b(run|trigger|execute|start|restart|kick off|fire)\b/.test(lower))
    return 'execute';

  // Write: deployment, config, permission changes
  if (
    /\b(deploy|create|delete|remove|destroy|configure|update|set|change|modify|add|install|uninstall|scale)\b/.test(
      lower,
    )
  )
    return 'write';

  // Explicit read patterns (for clarity, though default is read)
  if (
    /\b(list|show|get|describe|status|what|who|how|when|where|check|view|inspect|logs?|history)\b/.test(
      lower,
    )
  )
    return 'read';

  // Default: read
  return 'read';
}

// ---------------------------------------------------------------------------
// Auth gate result
// ---------------------------------------------------------------------------

export type AuthGateResult =
  | {
      passed: true;
      token: string;
      email: string;
      role: Role;
    }
  | {
      passed: false;
      reason: 'unauthenticated' | 'denied';
    };

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

/**
 * Check whether a user is authenticated and authorized to act in an enclave.
 *
 * mcpCall: caller provides this function (carries the user's Bearer token
 * per D6). Used to fetch enclave_info for POSIX mode bit checking.
 *
 * @param userId - Slack user ID.
 * @param enclaveName - Target enclave name.
 * @param messageText - User's message text (for classifyOperation).
 * @param tokenStore - Token store for the dispatcher.
 * @param config - OIDC config (unused here, kept for future use).
 * @param mcpCall - MCP call function for authz checks.
 */
export async function authGate(
  userId: string,
  enclaveName: string,
  messageText: string,
  tokenStore: UserTokenStore,
  _config: OidcConfig,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AuthGateResult> {
  // Step 1: Check for valid token
  const token = tokenStore.getValidTokenForUser(userId);
  if (!token) {
    return { passed: false, reason: 'unauthenticated' };
  }

  // Step 2: Extract identity from JWT
  const email = extractEmailFromToken(token);
  if (!email) {
    return { passed: false, reason: 'unauthenticated' };
  }

  // Step 3: Classify operation from message text
  const operation = classifyOperation(messageText);

  // Step 4: POSIX mode check
  const decision = await checkAccess(email, enclaveName, operation, mcpCall);
  if (!decision.allowed) {
    return { passed: false, reason: 'denied' };
  }

  return { passed: true, token, email, role: decision.role };
}
