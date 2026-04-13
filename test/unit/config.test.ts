import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

// Save and restore env for each test
const savedEnv: NodeJS.ProcessEnv = {};
const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'TENTACULAR_MCP_URL',
  'MCP_SERVICE_TOKEN',
  'GIT_STATE_REPO_URL',
  'ANTHROPIC_API_KEY',
];

function setRequiredEnv(): void {
  process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
  process.env['SLACK_SIGNING_SECRET'] = 'test-signing-secret';
  process.env['OIDC_ISSUER'] = 'https://keycloak.example.com/realms/test';
  process.env['OIDC_CLIENT_ID'] = 'thekraken';
  process.env['OIDC_CLIENT_SECRET'] = 'test-secret';
  process.env['TENTACULAR_MCP_URL'] = 'http://tentacular-mcp:8080';
  process.env['MCP_SERVICE_TOKEN'] = 'test-service-token';
  process.env['GIT_STATE_REPO_URL'] = 'https://github.com/test/workflows.git';
  // Narrow to anthropic-only to avoid requiring OpenAI/Gemini keys in tests
  // that don't care about multi-provider scenarios.
  process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic';
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
}

beforeEach(() => {
  // Save relevant env vars
  for (const key of REQUIRED_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Clear optional vars too
  delete process.env['SLACK_MODE'];
  delete process.env['SLACK_APP_TOKEN'];
  delete process.env['MCP_PORT'];
  delete process.env['LLM_DEFAULT_PROVIDER'];
  delete process.env['LLM_DEFAULT_MODEL'];
  delete process.env['LLM_ALLOWED_PROVIDERS'];
  delete process.env['LLM_ALLOWED_MODELS'];
  delete process.env['LLM_DISALLOWED_MODELS'];
  delete process.env['GIT_STATE_BRANCH'];
  delete process.env['GIT_STATE_DIR'];
  delete process.env['PORT'];
  delete process.env['OPENAI_API_KEY'];
  delete process.env['GEMINI_API_KEY'];
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  delete process.env['LOG_LEVEL'];
});

afterEach(() => {
  // Restore saved env
  for (const key of REQUIRED_VARS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe('loadConfig', () => {
  it('throws listing ALL missing required vars', () => {
    expect(() => loadConfig()).toThrow(/missing required env var:/);

    try {
      loadConfig();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('SLACK_BOT_TOKEN');
      expect(msg).toContain('SLACK_SIGNING_SECRET');
      expect(msg).toContain('OIDC_ISSUER');
      expect(msg).toContain('GIT_STATE_REPO_URL');
    }
  });

  it('throws when only GIT_STATE_REPO_URL is missing', () => {
    setRequiredEnv();
    delete process.env['GIT_STATE_REPO_URL'];

    expect(() => loadConfig()).toThrow(/GIT_STATE_REPO_URL/);
  });

  it('returns config with defaults when all required vars are set', () => {
    setRequiredEnv();
    const config = loadConfig();

    expect(config.slack.botToken).toBe('xoxb-test');
    expect(config.slack.mode).toBe('http');
    expect(config.oidc.issuer).toBe('https://keycloak.example.com/realms/test');
    expect(config.mcp.url).toBe('http://tentacular-mcp:8080');
    expect(config.mcp.port).toBe(8080);
    expect(config.gitState.repoUrl).toBe(
      'https://github.com/test/workflows.git',
    );
    expect(config.gitState.branch).toBe('main');
    expect(config.gitState.dir).toBe('/app/data/git-state');
    expect(config.server.port).toBe(3000);
    expect(config.llm.defaultProvider).toBe('anthropic');
    expect(config.llm.defaultModel).toBe('claude-sonnet-4-6');
    expect(config.llm.allowedProviders).toContain('anthropic');
    expect(config.llm.disallowedModels).toContain('gpt-4o');
  });

  it('requires SLACK_APP_TOKEN in socket mode', () => {
    setRequiredEnv();
    delete process.env['SLACK_SIGNING_SECRET'];
    process.env['SLACK_MODE'] = 'socket';
    // SLACK_APP_TOKEN is not set — should throw
    expect(() => loadConfig()).toThrow(/SLACK_APP_TOKEN/);
  });

  it('accepts socket mode when SLACK_APP_TOKEN is set', () => {
    setRequiredEnv();
    delete process.env['SLACK_SIGNING_SECRET'];
    process.env['SLACK_MODE'] = 'socket';
    process.env['SLACK_APP_TOKEN'] = 'xapp-test';
    const config = loadConfig();
    expect(config.slack.mode).toBe('socket');
    expect(config.slack.appToken).toBe('xapp-test');
  });

  it('parses LLM_ALLOWED_MODELS correctly', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_MODELS'] =
      'anthropic:claude-sonnet-4-6|claude-opus-4-6,openai:gpt-5.3-chat-latest';
    const config = loadConfig();
    expect(config.llm.allowedModels['anthropic']).toContain(
      'claude-sonnet-4-6',
    );
    expect(config.llm.allowedModels['anthropic']).toContain('claude-opus-4-6');
    expect(config.llm.allowedModels['openai']).toContain('gpt-5.3-chat-latest');
  });

  it('parses LLM_DISALLOWED_MODELS correctly', () => {
    setRequiredEnv();
    process.env['LLM_DISALLOWED_MODELS'] = 'model-a,model-b,model-c';
    const config = loadConfig();
    expect(config.llm.disallowedModels).toEqual([
      'model-a',
      'model-b',
      'model-c',
    ]);
  });

  it('applies custom optional values', () => {
    setRequiredEnv();
    process.env['GIT_STATE_BRANCH'] = 'production';
    process.env['GIT_STATE_DIR'] = '/data/state';
    process.env['PORT'] = '8000';
    process.env['MCP_PORT'] = '9090';
    const config = loadConfig();
    expect(config.gitState.branch).toBe('production');
    expect(config.gitState.dir).toBe('/data/state');
    expect(config.server.port).toBe(8000);
    expect(config.mcp.port).toBe(9090);
  });

  // Negative validation tests — Codex review T22 caught these gaps.

  it('rejects an unknown SLACK_MODE value', () => {
    setRequiredEnv();
    process.env['SLACK_MODE'] = 'bogus';
    expect(() => loadConfig()).toThrow(/SLACK_MODE.*bogus.*not one of/);
  });

  it('rejects an unknown LLM_DEFAULT_PROVIDER value', () => {
    setRequiredEnv();
    process.env['LLM_DEFAULT_PROVIDER'] = 'mistral';
    expect(() => loadConfig()).toThrow(
      /LLM_DEFAULT_PROVIDER.*mistral.*not one of/,
    );
  });

  it('rejects a non-numeric PORT', () => {
    setRequiredEnv();
    process.env['PORT'] = 'abc';
    expect(() => loadConfig()).toThrow(/PORT.*abc.*integer/);
  });

  it('rejects a non-numeric MCP_PORT', () => {
    setRequiredEnv();
    process.env['MCP_PORT'] = 'eighty';
    expect(() => loadConfig()).toThrow(/MCP_PORT.*eighty.*integer/);
  });

  it('rejects PORT out of range', () => {
    setRequiredEnv();
    process.env['PORT'] = '70000';
    expect(() => loadConfig()).toThrow(/PORT.*70000.*\[1, 65535\]/);
  });

  it('rejects PORT of zero', () => {
    setRequiredEnv();
    process.env['PORT'] = '0';
    expect(() => loadConfig()).toThrow(/PORT.*0.*\[1, 65535\]/);
  });

  it('combines missing required and invalid value errors in one throw', () => {
    setRequiredEnv();
    delete process.env['TENTACULAR_MCP_URL']; // missing required
    process.env['SLACK_MODE'] = 'bogus'; // invalid enum
    process.env['PORT'] = '999999'; // invalid range
    let err: unknown;
    try {
      loadConfig();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/TENTACULAR_MCP_URL/);
    expect(message).toMatch(/SLACK_MODE/);
    expect(message).toMatch(/PORT/);
  });

  // T04: LLM API key validation tests

  it('exposes MCP service token in config', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.mcp.serviceToken).toBe('test-service-token');
  });

  it('fails when ANTHROPIC_API_KEY missing and anthropic is default provider', () => {
    setRequiredEnv();
    delete process.env['ANTHROPIC_API_KEY'];
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY.*anthropic/);
  });

  it('fails when OPENAI_API_KEY missing and openai is in allowedProviders', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic,openai';
    // OPENAI_API_KEY not set — should throw
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY.*openai/);
  });

  it('fails when GEMINI_API_KEY missing and google is in allowedProviders', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic,google';
    // GEMINI_API_KEY not set — should throw
    expect(() => loadConfig()).toThrow(/GEMINI_API_KEY.*google/);
  });

  it('passes when all provider keys are set', () => {
    setRequiredEnv();
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
    process.env['GEMINI_API_KEY'] = 'gem-test';
    const config = loadConfig();
    expect(config.llm.anthropicApiKey).toBe('sk-ant-test');
    expect(config.llm.openaiApiKey).toBe('sk-openai-test');
    expect(config.llm.geminiApiKey).toBe('gem-test');
  });

  it('passes with anthropic-only config when allowedProviders is narrowed', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic';
    const config = loadConfig();
    expect(config.llm.allowedProviders).toEqual(['anthropic']);
  });

  it('exposes observability config with defaults', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic';
    const config = loadConfig();
    expect(config.observability.otlpEndpoint).toBe('');
    expect(config.observability.logLevel).toBe('info');
  });

  it('reads OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    setRequiredEnv();
    process.env['LLM_ALLOWED_PROVIDERS'] = 'anthropic';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://otel:4318';
    const config = loadConfig();
    expect(config.observability.otlpEndpoint).toBe('http://otel:4318');
  });
});
