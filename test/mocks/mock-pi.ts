/**
 * Mock pi CLI binary for integration/unit tests (T22).
 *
 * This script mimics the surface of the `pi` CLI used by TeamLifecycleManager.
 * It is compiled to a script and invoked via child_process.spawn() in tests
 * where we need to exercise team spawning without calling a real LLM.
 *
 * Supported flags (subset of pi CLI):
 *   --mode json          (required for RPC/json output mode)
 *   -p "prompt"         (print mode: run prompt and exit)
 *   --cwd <dir>          (working directory)
 *   --append-system-prompt <text>  (additional system prompt text)
 *
 * Behavior is controlled by MOCK_PI_SCENARIO env var:
 *   build-ok     - reads mailbox, writes outbound completion, exits
 *   deploy-ok    - reads mailbox, writes deploy completion signal, exits
 *   idle-exit    - waits for MOCK_PI_IDLE_TIMEOUT_MS then exits (default: 100ms)
 *   error        - writes an error signal and exits with code 1
 *   token-expired - writes a token-expired outbound message and exits
 *
 * All output goes to stdout as JSON events (pi json mode format).
 * The script reads KRAKEN_TEAM_DIR to find the mailbox/outbound/signals paths.
 *
 * Usage in tests:
 *   const piPath = resolve(__dirname, '../mocks/mock-pi.ts');
 *   // Use with tsx or pre-compiled
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENARIO = process.env['MOCK_PI_SCENARIO'] ?? 'idle-exit';
const TEAM_DIR = process.env['KRAKEN_TEAM_DIR'];
const IDLE_TIMEOUT_MS = Number(process.env['MOCK_PI_IDLE_TIMEOUT_MS'] ?? '100');

// Verify D6: TNTC_ACCESS_TOKEN must be present in the subprocess env
const ACCESS_TOKEN = process.env['TNTC_ACCESS_TOKEN'];

function appendNdjson(path: string, record: object): void {
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

function writeOutbound(
  type: string,
  text: string,
  channelId = 'C_TEST',
  threadTs = '1111111111.000',
): void {
  if (!TEAM_DIR) return;
  appendNdjson(join(TEAM_DIR, 'outbound.ndjson'), {
    id: `out-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type,
    channelId,
    threadTs,
    text,
  });
}

function writeSignal(type: string, message: string, source = 'builder'): void {
  if (!TEAM_DIR) return;
  // Dev team signals go to signals-in.ndjson (dev-team → manager direction).
  appendNdjson(join(TEAM_DIR, 'signals-in.ndjson'), {
    id: `sig-${Date.now()}`,
    timestamp: new Date().toISOString(),
    source,
    type,
    severity: 'info',
    taskId: 'task-mock',
    message,
    artifacts: [],
  });
}

interface MailboxMessage {
  channelId?: string;
  threadTs?: string;
  [key: string]: unknown;
}

function readMailbox(): MailboxMessage[] {
  if (!TEAM_DIR) return [];
  const path = join(TEAM_DIR, 'mailbox.ndjson');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as MailboxMessage);
}

/**
 * Extract channelId and threadTs from the first mailbox message.
 *
 * A real pi agent reads these from the mailbox to know where to post.
 * Without this, outbound records would have wrong channel/thread values.
 */
function getTargetFromMailbox(): { channelId: string; threadTs: string } {
  const messages = readMailbox();
  const first = messages[0];
  return {
    channelId: (first?.channelId as string | undefined) ?? 'C_TEST',
    threadTs: (first?.threadTs as string | undefined) ?? '1111111111.000',
  };
}

// Emit pi-style startup event on stdout
process.stdout.write(
  JSON.stringify({
    type: 'session_start',
    scenario: SCENARIO,
    teamDir: TEAM_DIR,
    // D6 check: confirm token is present but DO NOT echo it
    hasToken: !!ACCESS_TOKEN,
  }) + '\n',
);

async function run(): Promise<void> {
  switch (SCENARIO) {
    case 'build-ok': {
      // Read mailbox, write a completion signal + outbound message
      // Use channelId/threadTs from the first mailbox message so the
      // outbound record is routed back to the correct Slack thread.
      const messages = readMailbox();
      const { channelId, threadTs } = getTargetFromMailbox();
      writeSignal('task_started', 'Mock builder starting');
      writeSignal(
        'task_completed',
        `Mock builder done. Processed ${messages.length} mailbox messages.`,
      );
      writeOutbound(
        'slack_message',
        'Build complete! (mock)',
        channelId,
        threadTs,
      );
      process.exit(0);
      break;
    }

    case 'deploy-ok': {
      const { channelId, threadTs } = getTargetFromMailbox();
      writeSignal('task_started', 'Mock deployer starting', 'deployer');
      writeSignal('task_completed', 'Mock deploy done.', 'deployer');
      writeOutbound(
        'slack_message',
        'Deploy complete! (mock)',
        channelId,
        threadTs,
      );
      process.exit(0);
      break;
    }

    case 'error': {
      const { channelId, threadTs } = getTargetFromMailbox();
      writeSignal('error', 'Mock pi error scenario triggered');
      writeOutbound('error', 'An error occurred (mock)', channelId, threadTs);
      process.exit(1);
      break;
    }

    case 'token-expired': {
      // D6: token expired -> clean fail, no fallback
      const { channelId, threadTs } = getTargetFromMailbox();
      writeOutbound(
        'error',
        'Your session has expired. Please re-authenticate with /kraken auth.',
        channelId,
        threadTs,
      );
      process.exit(0);
      break;
    }

    case 'idle-exit':
    default: {
      // Wait for idle timeout then exit cleanly
      await new Promise<void>((resolve) =>
        setTimeout(resolve, IDLE_TIMEOUT_MS),
      );
      const { channelId, threadTs } = getTargetFromMailbox();
      writeOutbound(
        'slack_message',
        'Mock pi idle exit (mock)',
        channelId,
        threadTs,
      );
      process.exit(0);
      break;
    }
  }
}

void run().catch((err) => {
  process.stderr.write(`mock-pi error: ${String(err)}\n`);
  process.exit(1);
});
