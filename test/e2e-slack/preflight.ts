/**
 * Pre-flight checks for the E2E live test runner.
 *
 * Catches the configuration mistakes that previously caused
 * mysterious regressions:
 *
 *   1. Missing KUBECONFIG → harness mcpAssertion + cluster checks
 *      fail silently as "MCP unreachable" / "not found in ns/...".
 *   2. Stale team subprocess state (mailbox.ndjson with 22 days of
 *      accumulated failure-context) → the team's LLM mimics the
 *      old failure pattern even when everything is healthy.
 *
 * Env vars:
 *   KRAKEN_E2E_SKIP_PREFLIGHT=1    skip all preflight checks
 *   KRAKEN_E2E_FRESH_TEAMS=1       wipe stale team state before run
 *                                  (default: WARN if stale teams exist)
 *   KRAKEN_E2E_NAMESPACE           kraken namespace (default: tentacular-kraken)
 */

import { execSync } from 'node:child_process';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const KRAKEN_NS = process.env['KRAKEN_E2E_NAMESPACE'] ?? 'tentacular-kraken';

function tryKubectl(args: string): { ok: boolean; out: string; err: string } {
  try {
    const out = execSync(`kubectl ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const errStr = e.stderr
      ? typeof e.stderr === 'string'
        ? e.stderr
        : e.stderr.toString()
      : (e.message ?? String(err));
    return { ok: false, out: '', err: errStr };
  }
}

/**
 * Verify KUBECONFIG is set AND kubectl can reach the cluster AND the
 * Kraken namespace exists. Without this, all cluster-side assertions
 * silently fail as "not found".
 */
function checkClusterAccess(): { ok: boolean; reason: string } {
  if (!process.env['KUBECONFIG']) {
    return {
      ok: false,
      reason:
        'KUBECONFIG not set. Cluster assertions (F1 hello-world check, ' +
        'mcpAssertion OIDC bootstrap) will silently fail. ' +
        'Export KUBECONFIG=/path/to/kubeconfig before running.',
    };
  }
  const ns = tryKubectl(`get ns ${KRAKEN_NS} -o name`);
  if (!ns.ok) {
    return {
      ok: false,
      reason: `kubectl cannot reach cluster or namespace "${KRAKEN_NS}": ${ns.err.slice(0, 200)}`,
    };
  }
  return { ok: true, reason: 'cluster reachable' };
}

/**
 * Inspect /app/data/teams inside the Kraken pod. Stale dirs mean
 * accumulated mailbox context that poisons the next team-spawned
 * conversation with old failure patterns.
 *
 * Returns the list of team names that are present.
 */
function listTeamDirs(): string[] {
  const list = tryKubectl(
    `exec -n ${KRAKEN_NS} deploy/thekraken -- ls /app/data/teams 2>/dev/null || true`,
  );
  if (!list.ok) return [];
  return list.out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Wipe all team subprocess state + their stale ndjson cursors.
 * The cursor wipe is important: cursors point at byte offsets in
 * the (deleted) ndjson files, so without resetting them new teams
 * read from past-EOF and miss all incoming messages.
 */
function wipeTeams(teams: string[]): void {
  if (teams.length === 0) return;

  // Wipe on-disk dirs.
  const dirs = teams.map((t) => `/app/data/teams/${t}`).join(' ');
  const rm = tryKubectl(
    `exec -n ${KRAKEN_NS} deploy/thekraken -- rm -rf ${dirs}`,
  );
  if (!rm.ok) {
    throw new Error(`failed to wipe team dirs: ${rm.err.slice(0, 200)}`);
  }

  // Wipe ndjson cursors for the matching enclaves.
  const enclaveList = teams.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  const script =
    "const D=require('better-sqlite3');" +
    "const db=new D('/app/data/kraken.db');" +
    `const r=db.prepare("DELETE FROM ndjson_cursors WHERE enclave_name IN (${enclaveList})").run();` +
    'process.stdout.write(String(r.changes));' +
    'db.close();';
  const cur = tryKubectl(
    `exec -n ${KRAKEN_NS} deploy/thekraken -- node -e "${script}"`,
  );
  if (!cur.ok) {
    // Non-fatal — DB schema may not yet have the cursors table.
    console.warn(
      `[preflight] cursor wipe failed (non-fatal): ${cur.err.slice(0, 200)}`,
    );
  }
}

/**
 * Reset the enclaves that the E2E suite uses to a clean slate:
 *
 *   1. Delete the test enclave's k8s namespace (e.g. e2e-test or
 *      e2e-test-weu). Kraken's E2 scenario re-provisions it during
 *      the run. Without this, the namespace lingers across runs and
 *      provision tests are no-ops.
 *
 *   2. Remove transient tentacles that prior runs deposited in the
 *      persistent enclave (hello-world from F1, e2e-echo-probe-* from
 *      F-CRUD scenarios). Without this, deploy scenarios falsely pass
 *      because the workload was already there, and cleanup scenarios
 *      falsely fail because something else removed it first.
 *
 *   3. Delete enclave_binding rows that point at namespaces that no
 *      longer exist, so the dispatcher doesn't try to route to dead
 *      enclaves.
 *
 * Operator override:
 *   KRAKEN_E2E_PERSIST_ENCLAVE   name of the long-lived enclave whose
 *                                 namespace we MUST NOT delete (default:
 *                                 tentacular-agensys). Transient tentacles
 *                                 inside it are still removed.
 */
function resetTargetEnclaves(): void {
  const persistEnclave =
    process.env['KRAKEN_E2E_PERSIST_ENCLAVE'] ?? 'tentacular-agensys';
  const testEnclave = process.env['KRAKEN_E2E_TEST_ENCLAVE'] ?? 'e2e-test';

  // 1. Delete namespaces matching ${testEnclave}*. The cluster suffix
  // (-weu, -eastus, etc.) gets appended by Kraken at provision time.
  const nsList = tryKubectl(`get ns -o name`);
  if (nsList.ok) {
    const matches = nsList.out
      .split('\n')
      .map((s) => s.replace(/^namespace\//, '').trim())
      .filter(
        (n) =>
          (n === testEnclave || n.startsWith(`${testEnclave}-`)) &&
          n !== persistEnclave,
      );
    for (const n of matches) {
      const r = tryKubectl(`delete ns ${n} --wait=false --ignore-not-found`);
      if (r.ok) console.log(`[preflight] deleted ns ${n}`);
      else
        console.warn(
          `[preflight] delete ns ${n} failed: ${r.err.slice(0, 200)}`,
        );
    }
  }

  // 2. Remove transient tentacles from the persistent enclave. The names
  // here mirror what F-group scenarios deploy. Add new transient names
  // here when adding more deploy-style scenarios.
  const transientNames = ['hello-world'];
  // Also remove any e2e-echo-probe-* deployments left from F-CRUD.
  const allDeploys = tryKubectl(
    `-n ${persistEnclave} get deploy -o name 2>/dev/null`,
  );
  if (allDeploys.ok) {
    const echoes = allDeploys.out
      .split('\n')
      .map((s) => s.replace(/^deployment\.apps\//, '').trim())
      .filter((s) => /^e2e-echo-probe(-\d+)?$/.test(s));
    transientNames.push(...echoes);
  }
  for (const t of transientNames) {
    const r = tryKubectl(
      `-n ${persistEnclave} delete deploy,job,cronjob ${t} --wait=false --ignore-not-found`,
    );
    if (r.ok && r.out.trim())
      console.log(`[preflight] cleaned ${persistEnclave}/${t}`);
  }

  // 3. Prune enclave_bindings rows pointing at namespaces that no longer
  // exist. The dispatcher consults this table on routing. Two-step: list
  // bindings (in-pod) then check each namespace (from this host).
  const listBindings = tryKubectl(
    `exec -n ${KRAKEN_NS} deploy/thekraken -- node -e ` +
      `"const D=require('better-sqlite3');` +
      `const db=new D('/app/data/kraken.db');` +
      `process.stdout.write(JSON.stringify(db.prepare(\\\"SELECT channel_id, enclave_name FROM enclave_bindings\\\").all()));` +
      `db.close();"`,
  );
  if (!listBindings.ok) return;
  let bindings: Array<{ channel_id: string; enclave_name: string }> = [];
  try {
    bindings = JSON.parse(listBindings.out);
  } catch {
    return;
  }
  const dead: string[] = [];
  for (const b of bindings) {
    const r = tryKubectl(`get ns ${b.enclave_name} -o name 2>/dev/null`);
    if (!r.ok || !r.out.trim()) dead.push(b.channel_id);
  }
  if (dead.length > 0) {
    const channels = dead.map((c) => `'${c}'`).join(',');
    const delScript =
      "const D=require('better-sqlite3');" +
      "const db=new D('/app/data/kraken.db');" +
      `const r=db.prepare(\\\"DELETE FROM enclave_bindings WHERE channel_id IN (${channels})\\\").run();` +
      'process.stdout.write(String(r.changes));' +
      'db.close();';
    const del = tryKubectl(
      `exec -n ${KRAKEN_NS} deploy/thekraken -- node -e "${delScript}"`,
    );
    if (del.ok && del.out.trim()) {
      console.log(`[preflight] pruned ${del.out.trim()} dead enclave_bindings`);
    }
  }
}

export function runPreflight(): PreflightResult {
  const result: PreflightResult = { ok: true, errors: [], warnings: [] };

  if (process.env['KRAKEN_E2E_SKIP_PREFLIGHT'] === '1') {
    result.warnings.push('preflight skipped via KRAKEN_E2E_SKIP_PREFLIGHT=1');
    return result;
  }

  // Cluster access is mandatory in live mode.
  const cluster = checkClusterAccess();
  if (!cluster.ok) {
    result.ok = false;
    result.errors.push(cluster.reason);
    return result;
  }
  console.log(`[preflight] ${cluster.reason}`);

  // Team-state hygiene.
  const teams = listTeamDirs();
  if (teams.length > 0) {
    if (process.env['KRAKEN_E2E_FRESH_TEAMS'] === '1') {
      try {
        wipeTeams(teams);
        console.log(`[preflight] wiped ${teams.length} stale team dirs`);
      } catch (err) {
        result.ok = false;
        result.errors.push((err as Error).message);
        return result;
      }
    } else {
      result.warnings.push(
        `${teams.length} team dir(s) present: ${teams.join(', ')}. ` +
          'Accumulated mailbox context can cause the team LLM to ' +
          'mimic past failure patterns. Set KRAKEN_E2E_FRESH_TEAMS=1 ' +
          'to wipe before the run.',
      );
    }
  } else {
    console.log('[preflight] team dirs clean');
  }

  // Target-enclave reset: delete the test enclave's k8s namespace (it's
  // re-provisioned by E2). Also remove transient tentacles that previous
  // runs left in the persistent enclave (hello-world from F1; echo-probe
  // from F-CRUD scenarios). Gated by the same KRAKEN_E2E_FRESH_TEAMS flag
  // since it's part of "start from a clean slate" hygiene.
  if (process.env['KRAKEN_E2E_FRESH_TEAMS'] === '1') {
    try {
      resetTargetEnclaves();
    } catch (err) {
      result.warnings.push(`enclave reset partial: ${(err as Error).message}`);
    }
  }

  return result;
}
