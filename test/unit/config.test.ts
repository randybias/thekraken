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
  'GIT_STATE_REPO_URL',
];

function setRequiredEnv(): void {
  process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
  process.env['SLACK_SIGNING_SECRET'] = 'test-signing-secret';
  process.env['OIDC_ISSUER'] = 'https://keycloak.example.com/realms/test';
  process.env['OIDC_CLIENT_ID'] = 'thekraken';
  process.env['OIDC_CLIENT_SECRET'] = 'test-secret';
  process.env['TENTACULAR_MCP_URL'] = 'http://tentacular-mcp:8080';
  process.env['GIT_STATE_REPO_URL'] = 'https://github.com/test/workflows.git';
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
    expect(() => loadConfig()).toThrow(
      /missing required environment variables:/,
    );

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
});
