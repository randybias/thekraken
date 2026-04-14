/**
 * MCP tool scoping extension for pi-coding-agent team subprocesses.
 *
 * Loaded by team manager/builder/deployer via PI_EXTENSIONS env var.
 * Enforces enclave namespace boundaries for tentacular MCP tools.
 *
 * Architecture (design section 6.1):
 *   - Pi extension `tool_call` event wires into Agent.beforeToolCall via
 *     AgentSession._installAgentToolHooks()
 *   - Extensions can mutate event.input to inject namespace
 *   - Returning { block: true, reason } prevents tool execution
 *
 * Four tool categories:
 *   ENCLAVE_SCOPED: namespace-parameterized tools; namespace is injected
 *   BLOCKED_IN_ENCLAVE: admin/platform tools not available in enclave mode
 *   DM_ALLOWED: read-only tools allowed in DM mode (no enclave context)
 *   ALWAYS_ALLOWED: cluster-wide read tools, no namespace constraint
 *
 * Unknown tentacular tools are blocked for safety.
 */

// ---------------------------------------------------------------------------
// Tool category maps (ported from thekraken-reference/src/mcp-scope.ts)
// ---------------------------------------------------------------------------

const MCP_PREFIX = 'mcp__tentacular__';

/** Tools scoped to an enclave namespace. Value = parameter name to inject. */
const ENCLAVE_SCOPED: Record<string, string> = {
  wf_list: 'namespace',
  wf_describe: 'namespace',
  wf_status: 'namespace',
  wf_pods: 'namespace',
  wf_logs: 'namespace',
  wf_events: 'namespace',
  wf_jobs: 'namespace',
  wf_health: 'namespace',
  wf_health_ns: 'namespace',
  wf_apply: 'namespace',
  wf_run: 'namespace',
  wf_restart: 'namespace',
  wf_remove: 'namespace',
  enclave_info: 'name',
  enclave_sync: 'name',
  permissions_get: 'namespace',
  permissions_set: 'namespace',
  ns_permissions_get: 'namespace',
  ns_permissions_set: 'namespace',
};

/** Tools blocked in enclave mode (admin/platform only). */
const BLOCKED_IN_ENCLAVE = new Set([
  'ns_create',
  'ns_update',
  'ns_delete',
  'ns_list',
  'enclave_provision',
  'enclave_deprovision',
  'enclave_list',
  'cluster_preflight',
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

/** Tools allowed in DM mode (read-only, no namespace injection). */
const DM_ALLOWED = new Set([
  'wf_list',
  'wf_describe',
  'wf_status',
  'wf_pods',
  'wf_logs',
  'wf_events',
  'wf_jobs',
  'wf_health',
  'wf_health_ns',
  'health_cluster_summary',
  'health_nodes',
  'health_ns_usage',
  'enclave_info',
  'enclave_list',
  'permissions_get',
  'ns_permissions_get',
]);

/** Unscoped tools always allowed (cluster-wide read, no namespace constraint). */
const ALWAYS_ALLOWED = new Set([
  'health_cluster_summary',
  'health_nodes',
  'health_ns_usage',
]);

// ---------------------------------------------------------------------------
// Blocked tool hint messages
// ---------------------------------------------------------------------------

function getBlockedHint(shortName: string): string {
  if (shortName.startsWith('ns_'))
    return 'Namespace management is a platform operation.';
  if (shortName.startsWith('enclave_'))
    return 'Enclave management is handled by the dispatcher.';
  if (shortName.startsWith('audit_'))
    return 'Security audits require platform access.';
  if (shortName.startsWith('cluster_'))
    return 'Cluster operations require platform access.';
  return 'This tool requires elevated platform access.';
}

/** All known tentacular MCP tool names for scoping. */
const ALL_TENTACULAR_TOOLS = new Set([
  ...Object.keys(ENCLAVE_SCOPED),
  ...BLOCKED_IN_ENCLAVE,
  ...DM_ALLOWED,
  ...ALWAYS_ALLOWED,
]);

/** Returns true if this tool name belongs to the tentacular MCP surface. */
function isTentacularTool(name: string): boolean {
  return ALL_TENTACULAR_TOOLS.has(name);
}

// ---------------------------------------------------------------------------
// Pure evaluation function (exported for unit testing without pi infra)
// ---------------------------------------------------------------------------

export interface ScopeDecision {
  allowed: true;
  updatedInput?: Record<string, unknown>;
}

export type ScopeDenial = {
  allowed: false;
  reason: string;
};

export type EvaluateResult = ScopeDecision | ScopeDenial;

/**
 * Evaluate whether a tool call is allowed given the enclave context.
 *
 * This is a pure function — no side effects, no env access. The caller
 * provides enclaveName (null = DM mode, string = enclave mode).
 *
 * Returns the decision with optionally mutated input (namespace injection).
 */
export function evaluateToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  enclaveName: string | null,
): EvaluateResult {
  // Match both prefixed (mcp__tentacular__wf_list) and bare (wf_list) names.
  // In Kraken v2, tools register with bare names from the MCP server.
  // The MCP_PREFIX pattern is preserved for future Claude Code compatibility.
  const hasTentacularPrefix = toolName.startsWith(MCP_PREFIX);
  const shortName = hasTentacularPrefix
    ? toolName.slice(MCP_PREFIX.length)
    : toolName;

  // If the tool has the tentacular prefix, it MUST go through scoping
  // (even if we don't recognize the short name — fail-closed for unknown
  // tentacular tools). If it doesn't have the prefix, check if it's a
  // known tentacular tool by name (bare registration from MCP server).
  // Everything else (pi built-ins like read/bash/edit/write) passes through.
  if (!hasTentacularPrefix && !isTentacularTool(shortName)) {
    return { allowed: true };
  }

  // --- DM mode (enclaveName is null) ---
  if (enclaveName === null) {
    if (!DM_ALLOWED.has(shortName)) {
      return {
        allowed: false,
        reason:
          `Tool "${shortName}" requires an enclave context. ` +
          'Use this from an enclave Slack channel, not a DM.',
      };
    }
    return { allowed: true }; // allowed, no namespace injection in DM
  }

  // --- Enclave mode ---
  if (BLOCKED_IN_ENCLAVE.has(shortName)) {
    return {
      allowed: false,
      reason:
        `Tool "${shortName}" is not available in enclave mode. ` +
        getBlockedHint(shortName),
    };
  }

  if (ALWAYS_ALLOWED.has(shortName)) {
    return { allowed: true };
  }

  const paramName = ENCLAVE_SCOPED[shortName];
  if (paramName !== undefined) {
    const requested = toolInput[paramName];
    if (requested && requested !== enclaveName) {
      return {
        allowed: false,
        reason:
          `You can only operate within enclave "${enclaveName}". ` +
          `Cannot access "${requested}".`,
      };
    }
    // Inject enclave namespace
    const updatedInput = { ...toolInput, [paramName]: enclaveName };
    return { allowed: true, updatedInput };
  }

  // Unknown tentacular tool -> block for safety
  return {
    allowed: false,
    reason: `Tool "${shortName}" is not recognized. Contact your platform admin.`,
  };
}

// ---------------------------------------------------------------------------
// Pi extension factory (D8-compliant)
// ---------------------------------------------------------------------------

// The pi-coding-agent extension API.
// We define a minimal interface here to avoid hard-coupling to the pi package
// version. If pi's types change, only this interface needs updating.
interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

interface PiExtensionContext {
  on(
    event: 'tool_call',
    handler: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>,
  ): void;
}

type ExtensionFactory = (pi: PiExtensionContext) => void;

const toolScoping: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event) => {
    const input = event.input as Record<string, unknown>;
    const enclaveName = process.env['KRAKEN_ENCLAVE_NAME'] ?? null;

    const decision = evaluateToolCall(event.toolName, input, enclaveName);

    if (!decision.allowed) {
      return { block: true, reason: (decision as ScopeDenial).reason };
    }

    // Mutate input in place for namespace injection (per pi contract)
    const scopeDecision = decision as ScopeDecision;
    if (scopeDecision.updatedInput) {
      for (const [key, value] of Object.entries(scopeDecision.updatedInput)) {
        input[key] = value;
      }
    }

    return undefined; // allowed, proceed
  });
};

export default toolScoping;
