/**
 * The Kraken v2 configuration loader.
 *
 * Loads all configuration from environment variables. Validates required vars
 * and throws a single descriptive error listing ALL missing vars (not just the
 * first). Applies sensible defaults for optional vars.
 *
 * Git-state configuration is MANDATORY in v2 — no opt-in toggle. The Kraken
 * refuses to start if GIT_STATE_REPO_URL is unset.
 */

export interface SlackConfig {
  /** Slack bot OAuth token (xoxb-...). Required. */
  botToken: string;
  /** Slack app-level token for Socket Mode (xapp-...). Required if mode is 'socket'. */
  appToken?: string;
  /** Slack signing secret for HTTP Events API. Required if mode is 'http'. */
  signingSecret?: string;
  /** Transport mode. Default: 'http'. */
  mode: 'http' | 'socket';
}

export interface OidcConfig {
  /** Keycloak realm URL. Required. */
  issuer: string;
  /** OIDC client ID. Required. */
  clientId: string;
  /** OIDC client secret. Required. */
  clientSecret: string;
}

export interface McpConfig {
  /** URL of tentacular-mcp in-cluster server. Required. */
  url: string;
  /** Port for NetworkPolicy scoping. Default: 8080. */
  port: number;
  // No service token. MCP authentication is per-user only (D6).
  // Phase 1: no authenticated MCP calls possible (no OIDC yet).
  // Phase 2: per-user OIDC tokens from device flow stored in SQLite.
}

export interface LlmConfig {
  /** Default LLM provider. Default: 'anthropic'. */
  defaultProvider: 'anthropic' | 'openai' | 'google';
  /** Default model ID. Default: 'claude-sonnet-4-6'. */
  defaultModel: string;
  /** Allowed providers list. Default: ['anthropic', 'openai', 'google']. */
  allowedProviders: string[];
  /** Anthropic API key. Required when 'anthropic' is in allowedProviders. */
  anthropicApiKey?: string;
  /** OpenAI API key. Required when 'openai' is in allowedProviders. */
  openaiApiKey?: string;
  /** Google Gemini API key. Required when 'google' is in allowedProviders. */
  geminiApiKey?: string;
  /**
   * Allowed models per provider. If a provider key is absent, all models
   * from that provider are allowed (subject to disallowedModels).
   */
  allowedModels: Record<string, string[]>;
  /**
   * Globally disallowed model IDs. Takes precedence over allowedModels.
   * Default: ['gpt-4o', 'o3', 'o4-mini', 'gpt-5-nano', 'gpt-5-mini', 'gemini-2.5-pro']
   */
  disallowedModels: string[];
}

export interface GitStateConfig {
  /** Git repo URL for tentacle state. Required (hard fail if unset). */
  repoUrl: string;
  /** Branch to track. Default: 'main'. */
  branch: string;
  /** Local clone directory. Default: '/app/data/git-state'. */
  dir: string;
}

export interface ServerConfig {
  /** HTTP port for health endpoint and Slack Bolt. Default: 3000. */
  port: number;
}

export interface ObservabilityConfig {
  /**
   * OTLP HTTP endpoint for OTel trace export (e.g. http://otel-collector:4318).
   * Empty string = OTel disabled.
   */
  otlpEndpoint: string;
  /** Pino log level. Default: 'info'. */
  logLevel: string;
}

export interface KrakenConfig {
  slack: SlackConfig;
  oidc: OidcConfig;
  mcp: McpConfig;
  llm: LlmConfig;
  gitState: GitStateConfig;
  /**
   * Directory where per-enclave team state is stored.
   * Each enclave gets a subdirectory: {teamsDir}/{enclaveName}/
   * Defaults to /app/data/teams if unset.
   */
  teamsDir: string;
  server: ServerConfig;
  observability: ObservabilityConfig;
}

/**
 * Parse the LLM_ALLOWED_MODELS env var into a per-provider map.
 *
 * Format: "provider:model1|model2,provider:model1|model2"
 * Example: "anthropic:claude-sonnet-4-6|claude-opus-4-6,openai:gpt-5.3-chat-latest"
 */
function parseAllowedModels(raw: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!raw) return result;
  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) continue;
    const provider = entry.slice(0, colonIdx).trim();
    const models = entry
      .slice(colonIdx + 1)
      .split('|')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    if (provider && models.length > 0) {
      result[provider] = models;
    }
  }
  return result;
}

/**
 * Parse the LLM_DISALLOWED_MODELS env var into an array of model IDs.
 *
 * Format: "model1,model2,model3"
 */
function parseDisallowedModels(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Load and validate The Kraken v2 configuration from environment variables.
 *
 * Throws an error listing ALL missing required vars (not just the first).
 * Returns a frozen KrakenConfig object on success.
 */
export function loadConfig(): KrakenConfig {
  const missing: string[] = [];

  function required(name: string): string {
    const val = process.env[name];
    if (!val) {
      missing.push(name);
      return '';
    }
    return val;
  }

  function optional(name: string, defaultVal: string): string {
    return process.env[name] ?? defaultVal;
  }

  const errors: string[] = [];

  function validatedEnum<T extends string>(
    name: string,
    raw: string,
    allowed: readonly T[],
  ): T {
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    errors.push(`${name}="${raw}" is not one of [${allowed.join(', ')}]`);
    return allowed[0] as T;
  }

  function validatedPort(name: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(`${name}="${raw}" must be an integer in [1, 65535]`);
      return 0;
    }
    return n;
  }

  // Slack
  const botToken = required('SLACK_BOT_TOKEN');
  const slackMode = validatedEnum<'http' | 'socket'>(
    'SLACK_MODE',
    optional('SLACK_MODE', 'http'),
    ['http', 'socket'] as const,
  );
  const appToken =
    slackMode === 'socket'
      ? required('SLACK_APP_TOKEN')
      : (process.env['SLACK_APP_TOKEN'] ?? undefined);
  const signingSecret =
    slackMode !== 'socket'
      ? required('SLACK_SIGNING_SECRET')
      : (process.env['SLACK_SIGNING_SECRET'] ?? undefined);

  // OIDC
  const oidcIssuer = required('OIDC_ISSUER');
  const oidcClientId = required('OIDC_CLIENT_ID');
  const oidcClientSecret = required('OIDC_CLIENT_SECRET');

  // MCP
  const mcpUrl = required('TENTACULAR_MCP_URL');

  // Git state (mandatory — no opt-in toggle)
  const gitStateRepoUrl = required('GIT_STATE_REPO_URL');

  // LLM (validate defaultProvider before composing config)
  const defaultProvider = validatedEnum<'anthropic' | 'openai' | 'google'>(
    'LLM_DEFAULT_PROVIDER',
    optional('LLM_DEFAULT_PROVIDER', 'anthropic'),
    ['anthropic', 'openai', 'google'] as const,
  );
  const defaultModel = optional('LLM_DEFAULT_MODEL', 'claude-sonnet-4-6');
  const allowedProviders = optional(
    'LLM_ALLOWED_PROVIDERS',
    'anthropic,openai,google',
  )
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const allowedModels = parseAllowedModels(
    optional(
      'LLM_ALLOWED_MODELS',
      'anthropic:claude-sonnet-4-6|claude-opus-4-6|claude-sonnet-4-6-thinking,openai:gpt-5.3-chat-latest|gpt-5.4,google:gemini-3-pro-preview|gemini-3.1-pro',
    ),
  );
  const disallowedModels = parseDisallowedModels(
    optional(
      'LLM_DISALLOWED_MODELS',
      'gpt-4o,o3,o4-mini,gpt-5-nano,gpt-5-mini,gemini-2.5-pro',
    ),
  );

  // LLM API keys (T04: validate that configured providers have their keys)
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'] ?? undefined;
  const openaiApiKey = process.env['OPENAI_API_KEY'] ?? undefined;
  const geminiApiKey = process.env['GEMINI_API_KEY'] ?? undefined;

  // Validate: defaultProvider must have its key. Each allowedProvider must have its key.
  // Build combined set of required providers.
  const requiredProviders = new Set([defaultProvider, ...allowedProviders]);
  for (const provider of requiredProviders) {
    if (provider === 'anthropic' && !anthropicApiKey) {
      errors.push(
        `ANTHROPIC_API_KEY is required because 'anthropic' is in allowedProviders`,
      );
    }
    if (provider === 'openai' && !openaiApiKey) {
      errors.push(
        `OPENAI_API_KEY is required because 'openai' is in allowedProviders`,
      );
    }
    if (provider === 'google' && !geminiApiKey) {
      errors.push(
        `GEMINI_API_KEY is required because 'google' is in allowedProviders`,
      );
    }
  }

  // Observability
  const otlpEndpoint = optional('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  const logLevel = optional('LOG_LEVEL', 'info');

  const config: KrakenConfig = {
    slack: {
      botToken,
      appToken: appToken || undefined,
      signingSecret: signingSecret || undefined,
      mode: slackMode,
    },
    oidc: {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
    },
    mcp: {
      url: mcpUrl,
      port: validatedPort('MCP_PORT', optional('MCP_PORT', '8080')),
    },
    llm: {
      defaultProvider,
      defaultModel,
      allowedProviders,
      allowedModels,
      disallowedModels,
      anthropicApiKey,
      openaiApiKey,
      geminiApiKey,
    },
    gitState: {
      repoUrl: gitStateRepoUrl,
      branch: optional('GIT_STATE_BRANCH', 'main'),
      dir: optional('GIT_STATE_DIR', '/app/data/git-state'),
    },
    teamsDir: optional('KRAKEN_TEAMS_DIR', '/app/data/teams'),
    server: {
      port: validatedPort('PORT', optional('PORT', '3000')),
    },
    observability: {
      otlpEndpoint,
      logLevel,
    },
  };

  // Throw a single combined error covering both missing-required and invalid
  // values, so an operator sees the full picture in one shot.
  const issues = [
    ...missing.map((n) => `missing required env var: ${n}`),
    ...errors,
  ];
  if (issues.length > 0) {
    throw new Error(`KrakenConfig: ${issues.join('; ')}`);
  }

  return Object.freeze(config) as KrakenConfig;
}
