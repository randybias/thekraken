/**
 * MCP tool scoping for enclave-bound agents.
 *
 * Enforces that agents spawned from an enclave channel can only operate
 * within that enclave's namespace. Agents spawned from DMs get read-only
 * cross-enclave access.
 *
 * Uses the Claude Agent SDK's PreToolUse hook to intercept and modify
 * tool calls before they execute.
 */

import { logger } from '../logger.js';

/** Parameter name that carries the enclave scope for each tool. */
const ENCLAVE_SCOPED: Record<string, string> = {
  // Workflow lifecycle
  wf_list: 'enclave',
  wf_describe: 'enclave',
  wf_status: 'enclave',
  wf_pods: 'enclave',
  wf_logs: 'enclave',
  wf_events: 'enclave',
  wf_jobs: 'enclave',
  wf_health: 'enclave',
  wf_health_enclave: 'enclave',
  wf_apply: 'enclave',
  wf_run: 'enclave',
  wf_restart: 'enclave',
  wf_remove: 'enclave',
  // Enclave management (scoped to own enclave)
  enclave_info: 'name',
  enclave_sync: 'name',
  // Permissions
  permissions_get: 'enclave',
  permissions_set: 'enclave',
  ns_permissions_get: 'enclave',
  ns_permissions_set: 'enclave',
};

/** Tools that should never be available to enclave-scoped agents. */
const BLOCKED_IN_ENCLAVE = new Set([
  // Raw namespace ops — admin only
  'ns_create',
  'ns_update',
  'ns_delete',
  'ns_list',
  // Enclave provisioning — create a Slack channel instead
  'enclave_provision',
  'enclave_deprovision',
  // Cross-enclave listing — available in DM mode only
  'enclave_list',
  // Platform operator tools
  'enclave_preflight',
  'cluster_profile',
  'audit_rbac',
  'audit_netpol',
  'audit_psa',
  'gvisor_check',
  'exo_status',
  'exo_registration',
  'exo_list',
  'proxy_status',
]);

/** Tools allowed in DM (read-only) mode. Everything else is blocked. */
const DM_ALLOWED = new Set([
  'wf_list',
  'wf_describe',
  'wf_status',
  'wf_pods',
  'wf_logs',
  'wf_events',
  'wf_jobs',
  'wf_health',
  'wf_health_enclave',
  'health_cluster_summary',
  'health_nodes',
  'health_enclave_usage',
  'enclave_info',
  'enclave_list',
  'permissions_get',
  'ns_permissions_get',
]);

/** Unscoped tools that are always allowed (cluster-wide read). */
const ALWAYS_ALLOWED = new Set([
  'health_cluster_summary',
  'health_nodes',
  'health_enclave_usage',
]);

const MCP_PREFIX = 'mcp__tentacular__';

export type ScopeDecision =
  | {
      allowed: true;
      updatedInput?: Record<string, unknown>;
    }
  | {
      allowed: false;
      reason: string;
    };

/**
 * Evaluate whether a tool call should be allowed, and optionally
 * rewrite its parameters to enforce enclave scoping.
 *
 * @param toolName Full tool name (e.g., "mcp__tentacular__wf_list")
 * @param toolInput The tool's input parameters
 * @param enclaveName The verified enclave name, or null for DM mode
 */
export function evaluateToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  enclaveName: string | null,
): ScopeDecision {
  // Only scope tentacular MCP tools
  if (!toolName.startsWith(MCP_PREFIX)) {
    return { allowed: true };
  }

  const shortName = toolName.slice(MCP_PREFIX.length);

  // DM mode: read-only access only
  if (enclaveName === null) {
    if (!DM_ALLOWED.has(shortName)) {
      return {
        allowed: false,
        reason: `Tool "${shortName}" requires an enclave context. Use this from an enclave Slack channel, not a DM.`,
      };
    }
    // In DM mode, don't inject namespace — let the MCP server enforce
    // per-user access via the JWT for cross-enclave reads.
    return { allowed: true };
  }

  // Enclave mode: check blocked tools
  if (BLOCKED_IN_ENCLAVE.has(shortName)) {
    return {
      allowed: false,
      reason: `Tool "${shortName}" is not available in enclave mode. ${getBlockedHint(shortName)}`,
    };
  }

  // Enclave mode: always-allowed tools (no namespace injection needed)
  if (ALWAYS_ALLOWED.has(shortName)) {
    return { allowed: true };
  }

  // Enclave mode: scope to namespace
  const paramName = ENCLAVE_SCOPED[shortName];
  if (paramName) {
    const requestedNs = toolInput[paramName];
    if (requestedNs && requestedNs !== enclaveName) {
      logger.warn(
        { toolName: shortName, requested: requestedNs, enclave: enclaveName },
        'Blocked cross-enclave tool call',
      );
      return {
        allowed: false,
        reason: `You can only operate within enclave "${enclaveName}". Cannot access "${requestedNs}".`,
      };
    }
    // Inject the enclave namespace into the tool call
    const updatedInput = { ...toolInput, [paramName]: enclaveName };
    return { allowed: true, updatedInput };
  }

  // Unknown tentacular tool — block by default for safety
  logger.warn(
    { toolName: shortName, enclave: enclaveName },
    'Blocking unknown tentacular MCP tool (not in scope tables)',
  );
  return {
    allowed: false,
    reason: `Tool "${shortName}" is not recognized. Contact your platform admin.`,
  };
}

function getBlockedHint(shortName: string): string {
  if (shortName === 'enclave_provision') {
    return 'To create an enclave, create a new Slack channel and invite me to it.';
  }
  if (shortName === 'enclave_deprovision') {
    return 'Enclave removal requires a platform administrator.';
  }
  if (shortName === 'enclave_list') {
    return 'To see all your enclaves, DM me directly.';
  }
  if (shortName.startsWith('ns_')) {
    return 'Namespace operations are handled automatically through enclaves.';
  }
  return '';
}

/**
 * Build the explicit list of tentacular tools the agent is allowed to call.
 * Used for the `allowedTools` option in the Claude Agent SDK query().
 *
 * @param enclaveName The verified enclave name, or null for DM mode
 */
export function getAllowedTentacularTools(
  enclaveName: string | null,
): string[] {
  const tools: string[] = [];

  if (enclaveName === null) {
    // DM mode: only read-only tools
    for (const tool of DM_ALLOWED) {
      tools.push(`${MCP_PREFIX}${tool}`);
    }
  } else {
    // Enclave mode: scoped + always-allowed tools
    for (const tool of Object.keys(ENCLAVE_SCOPED)) {
      tools.push(`${MCP_PREFIX}${tool}`);
    }
    for (const tool of ALWAYS_ALLOWED) {
      if (!ENCLAVE_SCOPED[tool]) {
        tools.push(`${MCP_PREFIX}${tool}`);
      }
    }
  }

  return tools;
}
