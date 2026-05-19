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
 * Wipe ALL rows from the ndjson_cursors table. Necessary even when
 * no team dirs exist, because a stale cursor row pointing past the
 * end of a freshly-recreated mailbox.ndjson makes the bridge reader
 * silently skip every incoming message.
 */
function wipeAllCursors(): void {
  const script =
    "const D=require('better-sqlite3');" +
    "const db=new D('/app/data/kraken.db');" +
    "const r=db.prepare('DELETE FROM ndjson_cursors').run();" +
    'process.stdout.write(String(r.changes));' +
    'db.close();';
  const r = tryKubectl(
    `exec -n ${KRAKEN_NS} deploy/thekraken -- node -e "${script}"`,
  );
  if (r.ok) {
    console.log(`[preflight] wiped ${r.out.trim()} cursor rows`);
  } else {
    console.warn(
      `[preflight] cursor wipe failed (non-fatal): ${r.err.slice(0, 200)}`,
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

  // 2. Strict reset: delete ALL tentacle workloads from EVERY enclave
  // namespace before the run. Per operator policy, the cluster must have
  // NO tentacles of any kind prior to E2E execution — tests build what
  // they need from scratch. This includes the persistent enclave's
  // workloads (which is destructive in the development workspace but
  // intentional — git-state preserves the source-of-record).
  const allNs = tryKubectl(`get ns -o name`);
  if (allNs.ok) {
    const enclaveNamespaces = allNs.out
      .split('\n')
      .map((s) => s.replace(/^namespace\//, '').trim())
      .filter(
        (n) =>
          // Match Tentacular enclave namespaces: known persistent + any
          // matching the test enclave prefix. Don't touch system / observability /
          // kraken / mcp namespaces.
          n === persistEnclave ||
          n === testEnclave ||
          n.startsWith(`${testEnclave}-`),
      );
    for (const ns of enclaveNamespaces) {
      const r = tryKubectl(
        `-n ${ns} delete deploy,job,cronjob,statefulset --all --wait=false --ignore-not-found`,
      );
      if (r.ok && r.out.trim()) {
        console.log(
          `[preflight] wiped tentacle workloads in ${ns}: ${r.out.trim().split('\n').length} object(s)`,
        );
      }
    }
  }

  // 3. Prune enclave_bindings rows pointing at namespaces that no longer
  // exist OR are Terminating. The dispatcher consults this table on routing.
  // Terminating namespaces are treated as dead because --wait=false deletes
  // leave them in Terminating briefly; if we only check existence, the binding
  // survives and E2's enclave_provision is skipped (channel already bound),
  // leaving the new run without a live namespace to deploy into.
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
    const phase = tryKubectl(
      `get ns ${b.enclave_name} -o jsonpath={.status.phase} 2>/dev/null`,
    );
    const nsPhase = phase.out.trim();
    if (!phase.ok || !nsPhase || nsPhase === 'Terminating')
      dead.push(b.channel_id);
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
  // FRESH_TEAMS mode unconditionally wipes any present team dirs AND
  // all ndjson_cursors rows. The cursor wipe must run independent of
  // team-dir presence: stale cursor rows (left over from a previous
  // run whose team dir is already gone) point at byte offsets larger
  // than the freshly-recreated mailbox.ndjson, causing the bridge
  // reader to skip past every incoming message. The team-bridge
  // never processes mailbox records and the suite appears auth-broken
  // when in fact the reader is just past EOF.
  //
  // CRITICAL: wiping the team dirs is not enough when a bridge process
  // is already running inside the pod. Each bridge holds an open file
  // handle to its mailbox.ndjson. After rm -rf, the inode survives
  // until the file handle is closed. When the dispatcher recreates the
  // dir and writes the next message, the live bridge reads from the
  // stale (deleted) file and never sees new records. The team-lifecycle
  // still marks the enclave as "team active" (the bridge process is
  // running), so no new bridge is spawned.
  //
  // Fix: restart the pod before wiping dirs so all bridge subprocesses
  // are killed. We then wipe dirs and cursors against the idle pod.
  const teams = listTeamDirs();
  if (process.env['KRAKEN_E2E_FRESH_TEAMS'] === '1') {
    try {
      // Restart the pod first to kill in-process bridge subprocesses.
      // Without this, a bridge started for a prior manual test holds a
      // stale file handle to the mailbox.ndjson we are about to delete.
      const restart = tryKubectl(
        `rollout restart deployment/thekraken -n ${KRAKEN_NS}`,
      );
      if (!restart.ok) {
        throw new Error(`pod restart failed: ${restart.err.slice(0, 200)}`);
      }
      console.log(
        '[preflight] restarting Kraken pod to kill stale bridge processes...',
      );
      const ready = tryKubectl(
        `rollout status deployment/thekraken -n ${KRAKEN_NS} --timeout=120s`,
      );
      if (!ready.ok) {
        throw new Error(
          `pod did not become ready after restart: ${ready.err.slice(0, 200)}`,
        );
      }
      console.log('[preflight] Kraken pod ready');

      if (teams.length > 0) {
        wipeTeams(teams);
        console.log(`[preflight] wiped ${teams.length} stale team dir(s)`);
      } else {
        console.log('[preflight] no team dirs to wipe');
      }
      wipeAllCursors();
    } catch (err) {
      result.ok = false;
      result.errors.push((err as Error).message);
      return result;
    }
  } else if (teams.length > 0) {
    result.warnings.push(
      `${teams.length} team dir(s) present: ${teams.join(', ')}. ` +
        'Accumulated mailbox context can cause the team LLM to ' +
        'mimic past failure patterns. Set KRAKEN_E2E_FRESH_TEAMS=1 ' +
        'to wipe before the run.',
    );
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
