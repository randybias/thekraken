#!/usr/bin/env node
/**
 * E2E Slack test runner for The Kraken.
 *
 * Usage:
 *   npm run test:e2e-slack                  # run all scenarios
 *   npm run test:e2e-slack -- --scenario A1 # run a single scenario
 *   KRAKEN_E2E_DRY_RUN=1 npm run test:e2e-slack   # dry-run (mock, no real Slack)
 *
 * Output:
 *   Prints a table of Scenario / Status / Duration / Notes to stdout.
 *   Exits 0 if all scenarios pass (or skip).
 *   Exits 1 if any scenario fails or errors.
 *
 * Prerequisites:
 *   secrets get slack/tentacular-e2e/user-token   (xoxp-... Randy's user token)
 *   secrets get slack/tentacular-e2e/bot-token    (xoxb-... Kraken bot token)
 *   secrets get slack/tentacular-e2e/bot-user-id  (U... Kraken bot Slack user ID)
 *
 * Safety:
 *   - Only posts to #tentacular-agensys and #newkraken-test
 *   - All messages carry the "[e2e-test]" prefix from the Slack driver
 *   - Do NOT add production channels to CHANNELS in harness.ts
 */

import { bootHarness, runScenario, type ScenarioResult } from './harness.js';
import { ALL_SCENARIOS, findScenario } from './scenarios.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { scenarioId?: string } {
  const args = process.argv.slice(2);
  let scenarioId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) {
      scenarioId = args[i + 1];
      i++;
    }
  }

  return { scenarioId };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable(results: ScenarioResult[]): void {
  const COL_ID = 10;
  const COL_NAME = 40;
  const COL_STATUS = 8;
  const COL_DURATION = 10;
  const COL_NOTES = 60;

  function pad(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n - 1) + ' ' : s.padEnd(n);
  }

  const header =
    pad('Scenario', COL_ID) +
    pad('Name', COL_NAME) +
    pad('Status', COL_STATUS) +
    pad('Duration', COL_DURATION) +
    'Notes';

  const divider = '-'.repeat(COL_ID + COL_NAME + COL_STATUS + COL_DURATION + COL_NOTES);

  console.log('');
  console.log(header);
  console.log(divider);

  for (const r of results) {
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    const statusLabel =
      r.status === 'PASS'
        ? 'PASS'
        : r.status === 'SKIP'
          ? 'SKIP'
          : r.status === 'ERROR'
            ? 'ERROR'
            : 'FAIL';

    const line =
      pad(r.id, COL_ID) +
      pad(r.name, COL_NAME) +
      pad(statusLabel, COL_STATUS) +
      pad(duration, COL_DURATION) +
      (r.notes.length > COL_NOTES - 1
        ? r.notes.slice(0, COL_NOTES - 4) + '...'
        : r.notes);

    console.log(line);
  }

  console.log(divider);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function renderSummary(results: ScenarioResult[]): void {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const error = results.filter((r) => r.status === 'ERROR').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const total = results.length;

  console.log('');
  console.log(
    `Summary: ${pass}/${total} passed, ${fail} failed, ${error} errors, ${skip} skipped`,
  );

  if (fail > 0 || error > 0) {
    console.log('');
    console.log('Failed / Errored scenarios:');
    for (const r of results) {
      if (r.status === 'FAIL' || r.status === 'ERROR') {
        console.log(`  ${r.id} (${r.name}): ${r.notes}`);
        if (r.replyText) {
          const truncated =
            r.replyText.length > 200
              ? r.replyText.slice(0, 197) + '...'
              : r.replyText;
          console.log(`    Reply: ${truncated}`);
        }
      }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { scenarioId } = parseArgs();
  const isDryRun = process.env['KRAKEN_E2E_DRY_RUN'] === '1';

  console.log('The Kraken — E2E Slack test runner');
  if (isDryRun) {
    console.log('Mode: DRY RUN (mock Slack, no real messages sent)');
  } else {
    console.log('Mode: LIVE (posting real Slack messages)');
  }

  // Boot harness
  const { ctx, skipReason } = await bootHarness();

  if (!ctx) {
    console.warn(`SKIP: ${skipReason}`);
    console.log('');
    console.log('All scenarios skipped — credentials not available.');
    process.exit(0);
  }

  // Determine which scenarios to run
  let scenarios = ALL_SCENARIOS;
  if (scenarioId) {
    const found = findScenario(scenarioId);
    if (!found) {
      console.error(`Unknown scenario ID: ${scenarioId}`);
      console.error(
        `Available IDs: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`,
      );
      process.exit(1);
    }
    scenarios = [found];
  }

  console.log(`Running ${scenarios.length} scenario(s)...`);
  console.log('');

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id.padEnd(4)} ${scenario.name}... `);

    const result = await runScenario(ctx, scenario);
    results.push(result);

    const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
    console.log(`${result.status} (${duration})`);

    // Inter-scenario pause to avoid Slack rate limiting
    if (scenarios.indexOf(scenario) < scenarios.length - 1) {
      await new Promise<void>((r) => setTimeout(r, 2000));
    }
  }

  renderTable(results);
  renderSummary(results);

  const hasFailures = results.some(
    (r) => r.status === 'FAIL' || r.status === 'ERROR',
  );
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Fatal error in E2E runner:', err);
  process.exit(2);
});
