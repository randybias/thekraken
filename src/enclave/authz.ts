/**
 * POSIX-like authorization engine for enclave access control.
 *
 * Ported from thekraken-reference/src/authz.ts with:
 *   - Enclave info fetched via MCP call (caller provides mcpCall per D6)
 *   - 60-second enclave_info cache with per-enclave invalidation
 *   - Human-friendly denial messages (no jargon)
 *   - Frozen enclave enforcement (only owners can write/execute)
 *
 * Mode bits follow POSIX convention:
 *   chars 0-2: owner bits (rwx)
 *   chars 3-5: member/group bits (rwx)
 *   chars 6-8: visitor/other bits (rwx)
 *
 * Owners ALWAYS bypass mode checks (per POSIX: owner can always access
 * their own resources regardless of mode bits).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'member' | 'visitor';
export type Operation = 'read' | 'write' | 'execute';

export interface EnclaveInfo {
  /** Email of the enclave owner. */
  owner: string;
  /** Emails of enclave members. */
  members: string[];
  /** 9-char rwx mode string, e.g. "rwxrwxr-x". */
  mode: string;
  /** "active" | "frozen" */
  status: string;
  /** Enclave name (for cache key). */
  name: string;
}

export interface AuthzDecision {
  allowed: boolean;
  role: Role;
  /** Human-friendly denial reason (no jargon). Only present when allowed=false. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000; // 60 seconds

const cache = new Map<string, { info: EnclaveInfo; fetchedAt: number }>();

/** Invalidate the cached enclave info for a named enclave. */
export function invalidateCache(enclaveName: string): void {
  cache.delete(enclaveName);
}

function getCached(enclaveName: string): EnclaveInfo | undefined {
  const entry = cache.get(enclaveName);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(enclaveName);
    return undefined;
  }
  return entry.info;
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user's role in an enclave.
 *
 * Comparison is case-insensitive to handle email capitalisation variance.
 */
export function resolveRole(userEmail: string, info: EnclaveInfo): Role {
  const normalized = userEmail.toLowerCase();
  if (normalized === info.owner.toLowerCase()) return 'owner';
  if (info.members.some((m) => m.toLowerCase() === normalized)) return 'member';
  return 'visitor';
}

// ---------------------------------------------------------------------------
// Mode bit check
// ---------------------------------------------------------------------------

/**
 * Parse mode string and check if an operation is allowed for a role.
 *
 * Mode string: 9 chars, e.g. "rwxrwxr-x"
 *   chars 0-2: owner bits
 *   chars 3-5: member/group bits
 *   chars 6-8: visitor/other bits
 *
 * Owner ALWAYS bypasses mode checks (returns true regardless of bits).
 */
export function checkModeBit(
  mode: string,
  role: Role,
  operation: Operation,
): boolean {
  if (role === 'owner') return true;
  const offset = role === 'member' ? 3 : 6;
  const bitIdx = operation === 'read' ? 0 : operation === 'write' ? 1 : 2;
  const char = mode[offset + bitIdx];
  return char !== '-' && char !== undefined;
}

// ---------------------------------------------------------------------------
// Denial message templates
// ---------------------------------------------------------------------------

const DENIAL_FROZEN =
  'This enclave is currently frozen. No new tasks can be started until the owner unfreezes it.';

function buildDenial(role: Role, operation: Operation): string {
  if (role === 'visitor') {
    return (
      "You're visiting this enclave but don't have permission to " +
      `${operation === 'execute' ? 'run tasks' : operation} here. ` +
      'Ask the owner to add you as a member.'
    );
  }
  if (role === 'member') {
    if (operation === 'execute')
      return (
        "Members of this enclave don't have permission to run tasks. " +
        'Ask the owner to change the access level.'
      );
    if (operation === 'write')
      return (
        'Members of this enclave have read-only access. ' +
        'Ask the owner to change the access level.'
      );
    return (
      "You don't have permission to perform this action. " +
      'Ask the owner to adjust the access level.'
    );
  }
  return "You don't have permission to perform this action in this enclave.";
}

// ---------------------------------------------------------------------------
// Fetch enclave info (with cache)
// ---------------------------------------------------------------------------

async function fetchEnclaveInfo(
  enclaveName: string,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<EnclaveInfo | null> {
  const cached = getCached(enclaveName);
  if (cached) return cached;

  try {
    const raw = await mcpCall('enclave_info', { name: enclaveName });
    const info = raw as EnclaveInfo;
    cache.set(enclaveName, { info, fetchedAt: Date.now() });
    return info;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// checkAccess — main entry point
// ---------------------------------------------------------------------------

/**
 * Check whether a user may perform an operation in an enclave.
 *
 * mcpCall: a function that calls a tentacular-mcp tool. The caller provides
 * this — it carries the user's Bearer token per D6.
 *
 * If enclave_info fails (channel not bound, network error), returns
 * allowed=true so non-enclave channels degrade gracefully.
 */
export async function checkAccess(
  userEmail: string,
  enclaveName: string,
  operation: Operation,
  mcpCall: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AuthzDecision> {
  const info = await fetchEnclaveInfo(enclaveName, mcpCall);
  if (!info) return { allowed: true, role: 'visitor' };

  const role = resolveRole(userEmail, info);
  if (role === 'owner') return { allowed: true, role };

  // Frozen enclave: only owners can write/execute
  if (
    info.status === 'frozen' &&
    (operation === 'write' || operation === 'execute')
  ) {
    return { allowed: false, role, reason: DENIAL_FROZEN };
  }

  const allowed = checkModeBit(info.mode, role, operation);
  if (!allowed) {
    return { allowed: false, role, reason: buildDenial(role, operation) };
  }
  return { allowed: true, role };
}
