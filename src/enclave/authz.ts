/**
 * Authorization middleware for The Kraken.
 *
 * Checks the sender's permissions against the enclave's mode bits
 * before routing any message to the agent.
 *
 * Language rules (enforced in all user-facing strings here):
 * - Use "member", "visitor", "owner" — never "POSIX role" or "group bit"
 * - Use "access", "permission" — never "authorization" or "mode bits"
 * - Use "enclave" — never "namespace" or "cluster"
 * - Always suggest remedies
 */

import { logger } from '../logger.js';

export type Role = 'owner' | 'member' | 'visitor';
export type Operation = 'read' | 'write' | 'execute';

export interface EnclaveInfo {
  owner: string;
  members: string[];
  mode: string; // 9-char rwx string, e.g. "rwxrwxr-x"
  status: string; // "active" | "frozen"
  name: string;
}

export interface EnclaveCache {
  info: EnclaveInfo;
  fetchedAt: number;
}

export interface AuthzDecision {
  allowed: boolean;
  role: Role;
  reason?: string; // human-friendly denial explanation (no jargon)
}

const CACHE_TTL_MS = parseInt(process.env.AUTHZ_CACHE_TTL_MS ?? '60000', 10);

// In-memory cache: enclave name → EnclaveCache
const enclaveCache = new Map<string, EnclaveCache>();

export function invalidateAuthzCache(enclaveName: string): void {
  enclaveCache.delete(enclaveName);
}

export function getAuthzCache(enclaveName: string): EnclaveCache | undefined {
  const entry = enclaveCache.get(enclaveName);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    enclaveCache.delete(enclaveName);
    return undefined;
  }
  return entry;
}

/**
 * Fetch enclave info from MCP, with caching.
 * Returns undefined if the channel is not bound to an enclave.
 */
async function fetchEnclaveInfo(
  enclaveName: string,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<EnclaveInfo | undefined> {
  const cached = getAuthzCache(enclaveName);
  if (cached) return cached.info;

  try {
    const result = (await mcpCall('enclave_info', { name: enclaveName })) as {
      owner?: string;
      members?: string[];
      mode?: string;
      status?: string;
      name?: string;
    };

    if (!result?.owner) return undefined;

    const info: EnclaveInfo = {
      owner: result.owner,
      members: result.members ?? [],
      mode: result.mode ?? 'rwxrwx---',
      status: result.status ?? 'active',
      name: result.name ?? enclaveName,
    };

    enclaveCache.set(enclaveName, { info, fetchedAt: Date.now() });
    return info;
  } catch (err) {
    logger.debug(
      { enclaveName, err },
      'authz: enclave_info call failed — treating as non-enclave',
    );
    return undefined;
  }
}

/**
 * Resolve the user's role in the enclave.
 */
export function resolveRole(userEmail: string, info: EnclaveInfo): Role {
  const normalizedEmail = userEmail.toLowerCase();
  if (normalizedEmail === info.owner.toLowerCase()) return 'owner';
  if (info.members.some((m) => m.toLowerCase() === normalizedEmail))
    return 'member';
  return 'visitor';
}

/**
 * Parse mode string and check if an operation is allowed for a role.
 * Mode string format: 9 chars, e.g. "rwxrwxr-x"
 * - chars 0-2: owner bits (r, w, x)
 * - chars 3-5: member/group bits
 * - chars 6-8: visitor/other bits
 */
export function checkModeBit(mode: string, role: Role, operation: Operation): boolean {
  // Owner bypasses mode checks
  if (role === 'owner') return true;

  const offset = role === 'member' ? 3 : 6;
  const bitIdx = operation === 'read' ? 0 : operation === 'write' ? 1 : 2;
  const char = mode[offset + bitIdx];
  return char !== '-' && char !== undefined;
}

/**
 * Build a human-friendly denial message with remedy suggestion.
 */
export function buildDenialMessage(
  role: Role,
  operation: Operation,
  enclaveStatus: string,
): string {
  if (enclaveStatus === 'frozen') {
    return 'This enclave is currently frozen. No new tasks can be started until the owner unfreezes it.';
  }

  if (role === 'visitor') {
    return "You're visiting this enclave but don't have permission to run tasks here. Ask the owner to add you as a member.";
  }

  if (role === 'member') {
    if (operation === 'execute') {
      return "Members of this enclave don't have permission to run tasks. Ask the owner to change the access level.";
    }
    if (operation === 'write') {
      return 'Members of this enclave have read-only access. Ask the owner to change the access level.';
    }
    return "You don't have permission to perform this action. Ask the owner to adjust the access level.";
  }

  return "You don't have permission to perform this action in this enclave.";
}

/**
 * Check whether a user may perform an operation in an enclave.
 *
 * If enclave_info fails (channel not bound to an enclave), returns allowed=true
 * so non-enclave channels continue to work as before.
 */
export async function checkAccess(
  userEmail: string,
  enclaveName: string,
  operation: Operation,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AuthzDecision> {
  const info = await fetchEnclaveInfo(enclaveName, mcpCall);

  // Not an enclave — allow (backward compat)
  if (!info) {
    return { allowed: true, role: 'visitor' };
  }

  const role = resolveRole(userEmail, info);

  // Owner always allowed
  if (role === 'owner') {
    return { allowed: true, role };
  }

  // Frozen check for non-owners
  if (
    info.status === 'frozen' &&
    (operation === 'write' || operation === 'execute')
  ) {
    logger.info(
      { enclaveName, userEmail, role, operation },
      'authz: denied — enclave frozen',
    );
    return {
      allowed: false,
      role,
      reason: buildDenialMessage(role, operation, info.status),
    };
  }

  const allowed = checkModeBit(info.mode, role, operation);

  if (!allowed) {
    logger.info(
      { enclaveName, userEmail, role, operation, mode: info.mode },
      'authz: denied',
    );
    return {
      allowed: false,
      role,
      reason: buildDenialMessage(role, operation, info.status),
    };
  }

  logger.debug({ enclaveName, userEmail, role, operation }, 'authz: allowed');
  return { allowed: true, role };
}

/**
 * Classify a message as read, write, or execute based on content.
 * Default: read (least restrictive for ambiguous messages).
 */
export function classifyOperation(text: string): Operation {
  const lower = text.toLowerCase();

  // Execute: running tentacles
  if (/\b(run|trigger|execute|start|kick off|fire)\b/.test(lower))
    return 'execute';

  // Write: deployment, config, permission changes
  if (
    /\b(deploy|create|delete|remove|destroy|configure|update|set|change|modify|add|install|uninstall|scale|restart)\b/.test(
      lower,
    )
  )
    return 'write';

  // Read: status, listing, info
  if (
    /\b(list|show|get|describe|status|what|who|how|when|where|check|view|inspect|logs?|history)\b/.test(
      lower,
    )
  )
    return 'read';

  // Default to read for ambiguous messages
  return 'read';
}
