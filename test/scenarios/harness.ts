/**
 * Real-LLM scenario test harness.
 *
 * Spawns the actual pi-coding-agent subprocess with a real Anthropic API key
 * and a mock MCP HTTP server. Used to validate end-to-end agent behavior:
 * which tools the agent calls, how it formats outbound responses, and whether
 * it avoids jargon.
 *
 * Architecture:
 *   1. Start a mock MCP HTTP server (records all tool calls)
 *   2. Create a temp team directory (mailbox/outbound/signals NDJSON files)
 *   3. Write a user_message to mailbox.ndjson
 *   4. Spawn real pi with a system prompt teaching it the NDJSON IPC protocol
 *      and how to call MCP tools via curl
 *   5. Wait up to 60s for outbound.ndjson to have content
 *   6. Return outbound records + MCP call log
 *
 * The system prompt is minimal: just enough for the agent to understand the
 * mailbox/outbound protocol and how to call MCP tools. This tests whether
 * the agent follows the protocol correctly with real LLM reasoning.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startMockMcpServer,
  type MockMcpServer,
  type MockMcpServerOptions,
  type RecordedCall,
} from './mock-mcp-server.js';

// ---------------------------------------------------------------------------
// API key retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve the Anthropic API key from the secrets CLI.
 * Returns null if the key cannot be retrieved (tests will skip).
 */
export async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      '/usr/bin/env',
      ['sh', '-c', '~/global-bin/secrets get anthropic/primary/api-key'],
      {
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '/home/node',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      const key = output.trim();
      if (code === 0 && key && key.startsWith('sk-')) {
        resolve(key);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => resolve(null));

    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboundRecord {
  id?: string;
  timestamp?: string;
  type?: string;
  channelId?: string;
  threadTs?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ScenarioResult {
  /** Outbound records written by the agent during this run. */
  outbound: OutboundRecord[];
  /** MCP tool calls recorded by the mock server. */
  mcpCalls: RecordedCall[];
  /** Raw stdout from pi (JSON event stream). */
  stdout: string;
  /** Raw stderr from pi. */
  stderr: string;
  /** Exit code of the pi subprocess. */
  exitCode: number | null;
  /** Duration in milliseconds. */
  durationMs: number;
}

export interface ScenarioOptions {
  /** Scripted MCP responses (passed to mock server). */
  mcpResponses?: MockMcpServerOptions['responses'];
  /** User message to deliver via mailbox. */
  userMessage: string;
  /** Enclave name for context. Default: 'test-enclave'. */
  enclaveName?: string;
  /** Max time to wait for outbound content. Default: 60000ms. */
  timeoutMs?: number;
  /** Additional system prompt text appended after the base prompt. */
  extraSystemPrompt?: string;
  /** Expected min number of outbound records before resolving. Default: 1. */
  minOutboundRecords?: number;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the scenario agent.
 *
 * Teaches pi the minimal Kraken IPC protocol:
 * - Read messages from KRAKEN_TEAM_DIR/mailbox.ndjson
 * - Call MCP tools via curl to KRAKEN_MCP_URL
 * - Write responses to KRAKEN_TEAM_DIR/outbound.ndjson
 *
 * Does NOT include complex orchestration — just enough for single-turn
 * scenario testing.
 */
function buildScenarioSystemPrompt(
  enclaveName: string,
  extraPrompt?: string,
): string {
  const base = `# The Kraken — Scenario Agent

You are The Kraken, a conversational assistant for the Tentacular platform.
You help engineering teams manage their workflow tentacles running on Kubernetes.

## Your Role

You are operating in the **${enclaveName}** enclave. You have access to MCP tools
that query cluster state. Your job is to answer the user's question using these
tools and respond in plain, user-friendly language.

## IPC Protocol

Your working directory contains NDJSON files for communication:

1. **Read the user's message from mailbox.ndjson:**
   \`\`\`bash
   cat "$KRAKEN_TEAM_DIR/mailbox.ndjson"
   \`\`\`

2. **Call MCP tools via curl to get cluster data:**
   \`\`\`bash
   curl -s -X POST "$KRAKEN_MCP_URL/mcp/tools/call" \\
     -H "Content-Type: application/json" \\
     -d '{"name": "<tool_name>", "arguments": {"enclave": "${enclaveName}", ...}}'
   \`\`\`

3. **Write your response to outbound.ndjson** (REQUIRED — this is how your reply reaches Slack):
   \`\`\`bash
   echo '{"id":"<uuid>","timestamp":"<iso>","type":"slack_message","channelId":"<channelId>","threadTs":"<threadTs>","text":"<your friendly response>"}' >> "$KRAKEN_TEAM_DIR/outbound.ndjson"
   \`\`\`

## Critical Rules

- ALWAYS write at least one record to outbound.ndjson. If you skip this step, the user never sees your reply.
- Extract channelId and threadTs from the mailbox record and use them in your outbound record.
- Use the ACTUAL channel/thread from the mailbox — do not hardcode test values.
- Call MCP tools with \`enclave: "${enclaveName}"\` as a parameter when the tool requires it.
- Respond in plain English. Do NOT use Kubernetes jargon: no "namespace", "pod", "kubectl", "container".
  - Use friendly terms: "workflow" (not pod), "team" (not namespace), "running" (not Ready).
- Be concise. Users are engineers who prefer direct answers.
- Generate a proper UUID for outbound record IDs (use \`uuidgen\` or \`node -e "console.log(require('crypto').randomUUID())"\`).

## Available MCP Tools

Get the full list from: \`curl -s "$KRAKEN_MCP_URL/mcp/tools/list"\`

Key tools you will use:
- **wf_list**: List all workflows in the enclave. Args: \`{"enclave": "<name>"}\`
- **wf_health_enclave**: Get health of all workflows. Args: \`{"enclave": "<name>"}\`
- **wf_describe**: Describe a specific workflow. Args: \`{"enclave": "<name>", "name": "<wf-name>"}\`

## Workflow

1. Read mailbox.ndjson to get the user's message, channelId, and threadTs
2. Decide which MCP tools to call based on the message
3. Call the tools and interpret the results
4. Write a friendly, jargon-free response to outbound.ndjson
5. Exit (you are done — this is a single-turn interaction)
`.trim();

  if (extraPrompt) {
    return base + '\n\n' + extraPrompt;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run a single scenario against the real pi-coding-agent.
 *
 * @param opts - Scenario options including the user message and MCP responses.
 * @returns The scenario result with outbound records, MCP calls, and timing.
 */
export async function runScenario(
  opts: ScenarioOptions,
): Promise<ScenarioResult> {
  const {
    mcpResponses = {},
    userMessage,
    enclaveName = 'test-enclave',
    timeoutMs = 60000,
    extraSystemPrompt,
    minOutboundRecords = 1,
  } = opts;

  const startTime = Date.now();

  // 1. Start mock MCP server
  const mockServer: MockMcpServer = await startMockMcpServer({
    responses: mcpResponses,
  });

  // 2. Create temp team directory
  const teamDir = mkdtempSync(join(tmpdir(), 'kraken-scenario-'));
  mkdirSync(join(teamDir, 'memory'), { recursive: true });

  const mailboxPath = join(teamDir, 'mailbox.ndjson');
  const outboundPath = join(teamDir, 'outbound.ndjson');

  // 3. Write the user message to mailbox.ndjson
  const mailboxRecord = {
    id: `scenario-${Date.now()}`,
    timestamp: new Date().toISOString(),
    from: 'dispatcher',
    type: 'user_message',
    threadTs: '1712345678.123456',
    channelId: 'C_TEST_SCENARIO',
    userSlackId: 'U_SCENARIO_USER',
    userToken: 'test-token-scenario',
    message: userMessage,
  };
  appendFileSync(mailboxPath, JSON.stringify(mailboxRecord) + '\n', 'utf8');

  // 4. Resolve pi binary path
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const piBin = resolve(__dirname, '..', '..', 'node_modules', '.bin', 'pi');

  // 5. Get API key
  const apiKey = await getApiKey();
  if (!apiKey) {
    await mockServer.close();
    rmSync(teamDir, { recursive: true, force: true });
    throw new Error(
      'ANTHROPIC_API_KEY not available — scenario test cannot run',
    );
  }

  // 6. Build system prompt
  const systemPrompt = buildScenarioSystemPrompt(
    enclaveName,
    extraSystemPrompt,
  );

  // 7. Spawn pi in print mode
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/home/node',
    NODE_ENV: 'test',
    ANTHROPIC_API_KEY: apiKey,
    KRAKEN_TEAM_DIR: teamDir,
    KRAKEN_ENCLAVE_NAME: enclaveName,
    KRAKEN_MCP_URL: mockServer.url,
    TNTC_ACCESS_TOKEN: 'test-scenario-token',
    // Prevent pi from opening sessions in the test home dir
    PI_NO_SESSION: '1',
  };

  let stdout = '';
  let stderr = '';

  const proc: ChildProcess = spawn(
    piBin,
    [
      '--print',
      '--no-session',
      '--provider',
      'anthropic',
      '--system-prompt',
      systemPrompt,
      'Read the mailbox and respond to the user. Write your response to outbound.ndjson. Then exit.',
    ],
    {
      cwd: teamDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  // 8. Wait for outbound records or timeout
  const exitCode = await new Promise<number | null>((resolve) => {
    const deadline = Date.now() + timeoutMs;

    proc.on('exit', (code) => {
      resolve(code);
    });

    proc.on('error', () => {
      resolve(null);
    });

    // Deadline kill
    const deadlineTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, deadline - Date.now());

    // Clear timer on exit
    proc.on('exit', () => clearTimeout(deadlineTimer));
  });

  // 9. Wait briefly for file writes to flush
  await new Promise<void>((r) => setTimeout(r, 200));

  // 10. Read outbound records
  const outbound: OutboundRecord[] = [];
  if (existsSync(outboundPath)) {
    const lines = readFileSync(outboundPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    for (const line of lines) {
      try {
        outbound.push(JSON.parse(line) as OutboundRecord);
      } catch {
        // Ignore malformed lines
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const mcpCalls = [...mockServer.calls];

  // 11. Cleanup
  await mockServer.close();
  rmSync(teamDir, { recursive: true, force: true });

  // Warn if we got fewer outbound records than expected (don't throw — tests assert)
  if (outbound.length < minOutboundRecords) {
    console.warn(
      `[scenario] Expected >= ${minOutboundRecords} outbound records, got ${outbound.length}. ` +
        `exitCode=${exitCode}, durationMs=${durationMs}`,
    );
    if (stderr.trim()) {
      console.warn(`[scenario] stderr:\n${stderr.slice(0, 500)}`);
    }
  }

  return {
    outbound,
    mcpCalls,
    stdout,
    stderr,
    exitCode,
    durationMs,
  };
}
