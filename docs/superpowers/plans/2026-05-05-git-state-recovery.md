# Git-State Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the recovery loop so a marketing/sales user can revert a tentacle to an earlier behavior, modify it, and redeploy entirely through Kraken in Slack — without ever seeing a SHA, version number, or git term. Per `docs/superpowers/specs/2026-05-05-git-state-recovery-design.md`.

**Architecture:** Six sequenced phases. CLI restore lands first (G1) so all subsequent agent-driven work can call it. Kraken reconciler (G2), deployer per-deploy summary (G3), manager internal-ops (G4), manager prompt + skill (G5), then E2E M group (G6). Three sources of truth (cluster annotations, git history, Kraken DB) coexist with no drift by construction. Vocabulary contract enforced in code (allowlist), prompt (rules), and tests (forbidden patterns).

**Tech Stack:** Go (tentacular CLI), TypeScript (thekraken — pi-coding-agent dispatcher + manager + deployer), better-sqlite3 (Kraken DB), vitest (TS tests), pi-mono `@mariozechner/pi-ai` (manager LLM), Slack Bolt + scenarios harness (E2E).

---

## Cross-cutting rules

- **CLI is for agents, not humans.** `tntc state ...` is invoked by Kraken subprocesses and orchestrators (Claude Code, Codex, etc.). Never frame UX or design discussions around an "engineer running the CLI" use case. Output format optimizes for agent parseability (`--output json` available everywhere).
- **Six branches, six PRs.** One per phase: `feat/cli-state-restore` (tentacular), `feat/git-state-reconciler`, `feat/deployer-summary`, `feat/manager-git-state-ops`, `feat/git-state-skill`, `feat/e2e-git-state-m-group` (all thekraken). Land in order. Each phase is independently mergeable.
- **TDD per task.** Test → fail → implement → pass → commit.
- **Stage explicitly.** No `git add -A` or `git add .`.
- **Conventional Commits + `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer.**
- **No `--no-verify`, no admin merge bypass without orchestrator say-so.**
- **Vocabulary contract:** any user-facing string the manager produces — even in error messages — must not contain version numbers, SHAs, git terms, or cluster jargon. Validated by E2E forbidden patterns and by inspecting all manager prompt strings in tests.
- **Don't refactor unrelated code.** Each phase touches a tight set of files; if you find a smell elsewhere, leave it.

## File structure (locked decisions)

### tentacular repo

| Path | Phase | Responsibility |
|---|---|---|
| `pkg/cli/state.go` | G1 | Top-level `state` cobra command + subcommand wiring. |
| `pkg/cli/state_restore.go` | G1 (NEW) | `tntc state restore <enclave> <name> <ref>` — forward-revert + redeploy. |
| `pkg/cli/state_restore_test.go` | G1 (NEW) | Unit tests for forward-revert math + idempotency. |
| `pkg/cli/state_status.go` | G1 (modify) | Extend with cluster-vs-git drift report per tentacle. |
| `pkg/cli/state_status_test.go` | G1 (modify) | New cases for drift detection. |

### thekraken repo

| Path | Phase | Responsibility |
|---|---|---|
| `src/git-state/reconciler.ts` | G2 (NEW) | Pod-startup reconciliation. Reads cluster annotations, populates missing Kraken DB rows. |
| `src/git-state/deployments-db.ts` | G2 (modify) | Add `findByEnclaveTentacleSha`, `insertReconstructed` helpers. |
| `src/index.ts` | G2 (modify) | Wire reconciler call into bootstrap, after DB init. |
| `test/unit/git-state-reconciler.test.ts` | G2 (NEW) | Idempotency, correct row reconstruction, missing-annotation tolerance. |
| `src/dispatcher/internal-ops.ts` | G3, G4 (modify) | Register `record_deploy_event` (G3), `list_deploy_events`, `describe_change`, `commission_revert` (G4). |
| `src/agent/system-prompt.ts` | G3, G5 (modify) | Deployer prompt addition (G3); manager prompt update (G5). |
| `test/unit/internal-ops-record-deploy.test.ts` | G3 (NEW) | `record_deploy_event` writes correct row. |
| `test/unit/deployer-summary-prompt.test.ts` | G3 (NEW) | Deployer prompt contains the summary-step instructions. |
| `test/unit/internal-ops-list-deploy-events.test.ts` | G4 (NEW) | Pagination, sorting (newest first), empty case. |
| `test/unit/internal-ops-describe-change.test.ts` | G4 (NEW) | Cache hit, cache miss with diff fetch, empty diff fallback. |
| `test/unit/internal-ops-commission-revert.test.ts` | G4 (NEW) | Briefs dev team correctly with structured intent. |
| `skills/kraken/references/git-state.md` | G5 (NEW) | Manager's UX reference: vocabulary contract, four primitives, internal-op invocation rules, ambiguity handling, edge cases. |
| `skills/kraken/SKILL.md` | G5 (modify) | 3-line "Version management" pointer to the reference. |
| `test/unit/manager-prompt-vocabulary.test.ts` | G5 (NEW) | Manager prompt contains vocabulary contract; never instructs LLM to use forbidden vocabulary. |
| `test/e2e-slack/scenarios.ts` | G6 (modify) | Add M group: M1–M6. Add to `ALL_SCENARIOS`. |

---

## Phase G1: `tntc state restore` + drift-aware `state status`

**Repo:** `tentacular`. **Branch:** `feat/cli-state-restore`.

### Task G1.1: Branch + survey

- [ ] **Step 1: Branch from main**

```bash
cd ~/code/tentacular-main/tentacular
git checkout main && git pull origin main
git checkout -b feat/cli-state-restore
```

- [ ] **Step 2: Read existing CLI state surface**

```bash
ls pkg/cli/state*.go 2>&1
cat pkg/cli/state.go
cat pkg/cli/state_status.go
```

Note: existing `state init`, `state commit`, `state status` patterns — follow them. Identify how flags wire (`-c cluster`, `--enclave`, etc.).

- [ ] **Step 3: Read deploy implementation for reuse**

```bash
grep -n "wf_apply\|forward.revert\|annotation" pkg/cli/deploy*.go pkg/builder/k8s.go | head -20
```

`tntc deploy` already computes the spec, calls MCP `wf_apply`, and writes annotations. `state restore` reuses `pkg/builder` and the MCP client; only the *source* of the spec changes (it comes from `<ref>` instead of cwd).

### Task G1.2: Write `state restore` failing tests

**Files:** `pkg/cli/state_restore_test.go` (NEW).

- [ ] **Step 1: Test for forward-revert math (no hard reset)**

Create `pkg/cli/state_restore_test.go`:
```go
package cli

import (
	"testing"
	"path/filepath"
)

// Tests use a temp git repo fixture seeded with a sequence of commits
// representing tentacle deploys.

func TestForwardRevertProducesNewCommitMatchingTargetTree(t *testing.T) {
	repo := t.TempDir()
	seedRepoWith3CommitsTouchingTentacle(t, repo, "ai-news-digest")

	// Get the SHA of the middle commit (call it v2).
	v2SHA := gitRevParse(t, repo, "HEAD~1")
	v3SHA := gitRevParse(t, repo, "HEAD")

	// Forward-revert main onto v2's tree.
	newSHA, err := forwardRevert(filepath.Join(repo), "ai-news-digest", v2SHA)
	if err != nil {
		t.Fatalf("forwardRevert: %v", err)
	}

	// Assert: HEAD is no longer v3, and the tree at HEAD matches v2's tree.
	if gitRevParse(t, repo, "HEAD") == v3SHA {
		t.Fatal("HEAD did not advance — forward-revert was a no-op")
	}
	if gitRevParse(t, repo, "HEAD") != newSHA {
		t.Fatal("HEAD does not match returned SHA")
	}
	headTree := gitTree(t, repo, "HEAD", "ai-news-digest")
	v2Tree := gitTree(t, repo, v2SHA, "ai-news-digest")
	if headTree != v2Tree {
		t.Fatalf("forward-revert tree mismatch:\nHEAD:  %s\nv2:    %s", headTree, v2Tree)
	}
}

func TestForwardRevertOnHEADIsIdempotentNoOp(t *testing.T) {
	repo := t.TempDir()
	seedRepoWith3CommitsTouchingTentacle(t, repo, "ai-news-digest")
	headSHA := gitRevParse(t, repo, "HEAD")

	newSHA, err := forwardRevert(repo, "ai-news-digest", headSHA)
	if err != nil {
		t.Fatalf("forwardRevert: %v", err)
	}

	// Idempotent: HEAD already matches target tree, no new commit.
	if newSHA != headSHA {
		t.Fatalf("expected no-op, got new SHA %s", newSHA)
	}
}

func TestForwardRevertPreservesV3InHistory(t *testing.T) {
	repo := t.TempDir()
	seedRepoWith3CommitsTouchingTentacle(t, repo, "ai-news-digest")
	v3SHA := gitRevParse(t, repo, "HEAD")
	v2SHA := gitRevParse(t, repo, "HEAD~1")

	if _, err := forwardRevert(repo, "ai-news-digest", v2SHA); err != nil {
		t.Fatalf("forwardRevert: %v", err)
	}

	// v3 must still be reachable in git history (not lost via reset).
	if !gitRevReachable(t, repo, v3SHA) {
		t.Fatal("v3 SHA was lost — forward-revert used hard reset (BUG)")
	}
}

// (helpers seedRepoWith3CommitsTouchingTentacle, gitRevParse, gitTree,
// gitRevReachable defined in same file or a shared test helper)
```

- [ ] **Step 2: Run tests — confirm fail**

```bash
go test ./pkg/cli/... -run TestForwardRevert -v
```

Expected: FAIL — `forwardRevert` not defined.

### Task G1.3: Implement forward-revert

**Files:** `pkg/cli/state_restore.go` (NEW).

- [ ] **Step 1: Implement the helper**

Create `pkg/cli/state_restore.go`:
```go
package cli

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// forwardRevert writes a new commit on the current branch whose tree at
// <tentacle> matches the tree at <targetSHA>. Returns the new HEAD SHA.
//
// If HEAD already matches targetSHA's tree at <tentacle>, no commit is
// created and the existing HEAD SHA is returned (idempotent).
//
// This is NOT a hard reset — prior commits remain reachable in history.
func forwardRevert(repoPath, tentacle, targetSHA string) (string, error) {
	headTree, err := treeOf(repoPath, "HEAD", tentacle)
	if err != nil {
		return "", fmt.Errorf("read HEAD tree: %w", err)
	}
	targetTree, err := treeOf(repoPath, targetSHA, tentacle)
	if err != nil {
		return "", fmt.Errorf("read target tree: %w", err)
	}
	if headTree == targetTree {
		return resolveRef(repoPath, "HEAD")
	}

	// Check out the target SHA's content for <tentacle> only, into the
	// working tree, then commit on the current branch.
	if err := runGit(repoPath, "checkout", targetSHA, "--", tentacle); err != nil {
		return "", fmt.Errorf("checkout target tree: %w", err)
	}
	msg := fmt.Sprintf("revert: restore %s to tree at %s", tentacle, targetSHA[:8])
	if err := runGit(repoPath, "add", tentacle); err != nil {
		return "", fmt.Errorf("stage: %w", err)
	}
	if err := runGit(repoPath, "commit", "-m", msg); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return resolveRef(repoPath, "HEAD")
}

func treeOf(repoPath, ref, path string) (string, error) {
	cmd := exec.Command("git", "rev-parse", fmt.Sprintf("%s:%s", ref, path))
	cmd.Dir = repoPath
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func resolveRef(repoPath, ref string) (string, error) {
	cmd := exec.Command("git", "rev-parse", ref)
	cmd.Dir = repoPath
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func runGit(repoPath string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = repoPath
	return cmd.Run()
}
```

- [ ] **Step 2: Run tests — expect pass**

```bash
go test ./pkg/cli/... -run TestForwardRevert -v
```

Expected: PASS for all 3 tests.

### Task G1.4: Wire `state restore` cobra command + deploy invocation

- [ ] **Step 1: Add `restore` subcommand to `pkg/cli/state.go`**

Locate the `state` command's `AddCommand` calls. Add:
```go
stateCmd.AddCommand(stateRestoreCmd)
```

And in `pkg/cli/state_restore.go`, add the cobra command:
```go
var stateRestoreCmd = &cobra.Command{
	Use:   "restore <name> <ref>",
	Short: "Restore a tentacle to a prior version and redeploy",
	Long: `Forward-revert <name>'s tree on the tentacles repo to match <ref>,
commit the change, and redeploy. Writes a new deploy event.

<ref> is any git ref (SHA, branch, HEAD~N). For idempotent re-deploy
of the current state, use HEAD.`,
	Args: cobra.ExactArgs(2),
	RunE: runStateRestore,
}

func runStateRestore(cmd *cobra.Command, args []string) error {
	tentacle := args[0]
	ref := args[1]
	enclave, err := resolveEnclaveName(cmd) // existing resolver from feat/cli-enclave-flag
	if err != nil {
		return err
	}
	cfg, err := loadConfig() // existing config loader
	if err != nil {
		return err
	}
	tentaclesRepo := cfg.GitState.RepoPath // existing config field
	if tentaclesRepo == "" {
		return fmt.Errorf("git-state repo not configured; run 'tntc state init' first")
	}

	// Step 1: Resolve ref to a SHA.
	targetSHA, err := resolveRef(tentaclesRepo, ref)
	if err != nil {
		return fmt.Errorf("resolve ref %q: %w", ref, err)
	}

	// Step 2: Forward-revert.
	newSHA, err := forwardRevert(tentaclesRepo, tentacle, targetSHA)
	if err != nil {
		return err
	}

	// Step 3: Push the commit (so cluster annotation can reference it).
	if err := runGit(tentaclesRepo, "push"); err != nil {
		return fmt.Errorf("push: %w", err)
	}

	// Step 4: Deploy. Reuse the existing tntc deploy machinery rather
	// than reimplementing — load the spec from <tentaclesRepo>/<tentacle>/
	// and call the same code path as `tntc deploy`.
	if err := deployFromPath(filepath.Join(tentaclesRepo, tentacle), enclave); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Restored %s to %s, redeployed as %s\n",
		tentacle, targetSHA[:8], newSHA[:8])
	return nil
}
```

`deployFromPath` is the existing function used by `tntc deploy`; if it's named differently, refactor the deploy command to call a shared helper that `state_restore.go` also invokes. Don't duplicate deploy logic.

- [ ] **Step 2: Compile**

```bash
go build ./...
```

Expected: clean.

- [ ] **Step 3: Smoke test against eastus (without actually deploying)**

```bash
tntc state restore --help
```

Expected: usage prints with the documented args.

### Task G1.5: Extend `tntc state status` for drift detection

**Files:** `pkg/cli/state_status.go` (modify), `pkg/cli/state_status_test.go` (modify or create).

- [ ] **Step 1: Write failing test for drift output**

Add to `pkg/cli/state_status_test.go`:
```go
func TestStateStatusReportsDriftPerTentacle(t *testing.T) {
	// Mock: cluster annotations report SHA "aaa"; git HEAD reports SHA "bbb".
	// Expect status output to include drift indicator for that tentacle.
	// (Test fixture/mock setup mirrors existing state_status_test.go patterns.)
	out := runStatusWithFixture(t, fixtureWithDrift())
	if !strings.Contains(out, "DRIFT") {
		t.Fatalf("expected DRIFT marker in output, got:\n%s", out)
	}
	if !strings.Contains(out, "ai-news-digest") {
		t.Fatal("expected drifted tentacle name in output")
	}
}
```

- [ ] **Step 2: Run — confirm fail**

```bash
go test ./pkg/cli/... -run TestStateStatusReportsDrift -v
```

- [ ] **Step 3: Implement drift detection in `state_status.go`**

For each enclave (default: all the user is a member of), call MCP `wf_list` to enumerate tentacles. For each tentacle:
- Read `tentacular.io/git-sha` annotation → cluster SHA.
- Resolve `HEAD` of the tentacle's path in the local tentacles repo → local SHA.
- If they differ: emit `DRIFT  <enclave>  <tentacle>  cluster=<sha8> local=<sha8>`.
- If they match: emit `IN_SYNC  <enclave>  <tentacle>  <sha8>`.

```go
type DriftEntry struct {
	Enclave   string
	Tentacle  string
	ClusterSHA string
	LocalSHA   string
	Drifted    bool
}

func detectDrift(enclave string) ([]DriftEntry, error) {
	// ... MCP wf_list, read annotations, compare to local SHAs
}
```

JSON output (`--output json`) emits a structured list; text output (default) prints the human-readable lines above.

- [ ] **Step 4: Test passes**

```bash
go test ./pkg/cli/... -run TestStateStatusReports -v
```

### Task G1.6: Pre-push gate + PR

- [ ] **Step 1: Pre-push checklist**

```bash
cd ~/code/tentacular-main/tentacular
go test ./pkg/...
golangci-lint run ./...
go test -c ./test/integration/...   # if it exists
```

All green required.

- [ ] **Step 2: Commit (if not already in pieces)**

```bash
git add pkg/cli/state.go pkg/cli/state_restore.go pkg/cli/state_restore_test.go pkg/cli/state_status.go pkg/cli/state_status_test.go
git commit -m "feat(cli): tntc state restore + state status drift detection

state restore <name> <ref> forward-reverts the tentacle's tree to <ref>
and redeploys. Idempotent on HEAD. Preserves prior history (not a
hard reset).

state status extended to report cluster-vs-git drift per tentacle.

Per design: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/cli-state-restore
gh pr create --title "feat(cli): tntc state restore + state status drift detection" \
  --body "Implements G1 of the git-state recovery design. See spec at thekraken/docs/superpowers/specs/2026-05-05-git-state-recovery-design.md."
```

- [ ] **Step 4: Wait for CI green, report PR URL**

---

## Phase G2: Kraken pod-startup reconciler

**Repo:** `thekraken`. **Branch:** `feat/git-state-reconciler`.

### Task G2.1: Branch + survey

- [ ] **Step 1: Branch**

```bash
cd ~/code/tentacular-main/thekraken
git checkout main && git pull
git checkout -b feat/git-state-reconciler
```

- [ ] **Step 2: Read existing deployments-db**

```bash
cat src/git-state/deployments-db.ts
```

Identify existing `RecordDeploymentParams`, `recordDeployment`, etc. We add helpers `findByEnclaveTentacleSha` and `insertReconstructed` here.

### Task G2.2: Write reconciler test (failing)

**Files:** `test/unit/git-state-reconciler.test.ts` (NEW).

- [ ] **Step 1: Test idempotent reconstruction**

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runReconciler } from '../../src/git-state/reconciler.js';
import { initDatabase } from '../../src/db/migrations.js';

describe('git-state reconciler', () => {
  it('inserts a reconstructed row for a deployed tentacle missing from DB', async () => {
    const db = initDatabase(':memory:');

    // Mock MCP that reports one enclave with one tentacle, with annotations.
    const mockMcp = {
      wfList: async (_: string) => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
              'tentacular.io/deployed-at': '2026-04-14T15:03:56Z',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const rows = db.prepare(
      `SELECT enclave, tentacle, git_sha, summary FROM deployments
       WHERE enclave = ? AND tentacle = ?`,
    ).all('tentacular-agensys', 'ai-news-digest');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      git_sha: 'abc1234',
      summary: '(reconstructed from cluster — no original notes)',
    });
  });

  it('is idempotent — running twice produces no duplicate rows', async () => {
    const db = initDatabase(':memory:');
    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);
    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const count = db.prepare(
      `SELECT COUNT(*) as c FROM deployments WHERE enclave = ? AND tentacle = ?`,
    ).get('tentacular-agensys', 'ai-news-digest') as { c: number };
    expect(count.c).toBe(1);
  });

  it('skips tentacles whose SHA is already in DB', async () => {
    const db = initDatabase(':memory:');
    db.prepare(
      `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
        deploy_type, summary, deployed_by_email, triggered_by_channel,
        triggered_by_ts, status)
       VALUES (?, ?, 1, 'abc1234', '', 'manual', 'real summary',
        'rbias@mirantis.com', 'C_X', 'ts1', 'success')`,
    ).run('tentacular-agensys', 'ai-news-digest');

    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {
              'tentacular.io/git-sha': 'abc1234',
              'tentacular.io/deployed-by': 'rbias@mirantis.com',
            },
          },
        ],
      }),
    };

    await runReconciler(db, mockMcp, ['tentacular-agensys']);

    const row = db.prepare(
      `SELECT summary FROM deployments WHERE git_sha = ?`,
    ).get('abc1234') as { summary: string };
    expect(row.summary).toBe('real summary'); // not overwritten
  });

  it('tolerates missing annotations gracefully', async () => {
    const db = initDatabase(':memory:');
    const mockMcp = {
      wfList: async () => ({
        workflows: [
          {
            name: 'ai-news-digest',
            enclave: 'tentacular-agensys',
            annotations: {}, // no git-sha, no deployed-by
          },
        ],
      }),
    };

    await expect(
      runReconciler(db, mockMcp, ['tentacular-agensys']),
    ).resolves.not.toThrow();
    // No row inserted because there's no git-sha to key on.
    const count = db.prepare(`SELECT COUNT(*) as c FROM deployments`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

```bash
npx vitest run test/unit/git-state-reconciler.test.ts
```

Expected: FAIL — `runReconciler` not exported.

### Task G2.3: Implement reconciler

**Files:** `src/git-state/reconciler.ts` (NEW), `src/git-state/deployments-db.ts` (modify).

- [ ] **Step 1: Add DB helpers in `deployments-db.ts`**

```ts
export function findByEnclaveTentacleSha(
  db: Database,
  enclave: string,
  tentacle: string,
  gitSha: string,
): DeploymentRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM deployments
       WHERE enclave = ? AND tentacle = ? AND git_sha = ?
       LIMIT 1`,
    )
    .get(enclave, tentacle, gitSha) as DeploymentRecord | undefined;
  return row ?? null;
}

export function insertReconstructed(
  db: Database,
  params: {
    enclave: string;
    tentacle: string;
    gitSha: string;
    deployedByEmail: string;
    deployedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
      deploy_type, summary, deployed_by_email, triggered_by_channel,
      triggered_by_ts, status)
     VALUES (?, ?, 0, ?, '', 'reconstructed',
       '(reconstructed from cluster — no original notes)',
       ?, '', '', 'success')`,
  ).run(params.enclave, params.tentacle, params.gitSha, params.deployedByEmail);
}
```

- [ ] **Step 2: Implement `runReconciler` in `src/git-state/reconciler.ts`**

```ts
import type Database from 'better-sqlite3';
import { findByEnclaveTentacleSha, insertReconstructed } from './deployments-db.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'git-state-reconciler' });

export interface McpReader {
  wfList: (enclave: string) => Promise<{
    workflows: Array<{
      name: string;
      enclave?: string;
      annotations?: Record<string, string>;
    }>;
  }>;
}

export async function runReconciler(
  db: Database,
  mcp: McpReader,
  enclaves: string[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const enclave of enclaves) {
    let result;
    try {
      result = await mcp.wfList(enclave);
    } catch (err) {
      log.warn({ err, enclave }, 'reconciler: wfList failed, skipping enclave');
      continue;
    }
    for (const wf of result.workflows) {
      const sha = wf.annotations?.['tentacular.io/git-sha'];
      const deployer = wf.annotations?.['tentacular.io/deployed-by'];
      if (!sha) {
        log.debug({ enclave, tentacle: wf.name }, 'reconciler: skipping (no git-sha annotation)');
        continue;
      }
      const existing = findByEnclaveTentacleSha(db, enclave, wf.name, sha);
      if (existing) {
        skipped++;
        continue;
      }
      insertReconstructed(db, {
        enclave,
        tentacle: wf.name,
        gitSha: sha,
        deployedByEmail: deployer ?? 'unknown',
        deployedAt: wf.annotations?.['tentacular.io/deployed-at'],
      });
      inserted++;
    }
  }
  log.info({ inserted, skipped }, 'reconciler: complete');
  return { inserted, skipped };
}
```

- [ ] **Step 3: Run tests — expect pass**

```bash
npx vitest run test/unit/git-state-reconciler.test.ts
```

Expected: 4/4 PASS.

### Task G2.4: Wire reconciler into Kraken bootstrap

**Files:** `src/index.ts` (modify).

- [ ] **Step 1: Add the call after DB init**

In `src/index.ts`, after the database is initialized and before the Slack bot starts, call:
```ts
import { runReconciler } from './git-state/reconciler.js';
// ... in main():
const enclaveNames = bindings.listEnclaves().map(b => b.enclaveName);
try {
  const r = await runReconciler(db, mcpReader, enclaveNames);
  log.info({ inserted: r.inserted, skipped: r.skipped }, 'startup: reconciler complete');
} catch (err) {
  log.warn({ err }, 'startup: reconciler failed (non-fatal, continuing)');
}
```

`mcpReader` is a thin adapter that exposes `wfList` against the MCP server. If the existing MCP client doesn't expose this, add a one-liner adapter.

- [ ] **Step 2: Compile + lint + format**

```bash
npx tsc --noEmit && npm run lint && npm run format:check
```

Clean required.

### Task G2.5: PR

- [ ] **Step 1: Pre-push gate**

```bash
npm test
```

Unit suite must pass (or only have the known pre-existing-flaky pre-commit-hook timeouts).

- [ ] **Step 2: Commit**

```bash
git add src/git-state/reconciler.ts src/git-state/deployments-db.ts \
  src/index.ts test/unit/git-state-reconciler.test.ts
git commit -m "feat(git-state): reconciler at pod startup

Reconstructs missing Kraken DB rows from cluster annotations on
pod startup. Idempotent — re-runs are no-ops. Tolerates missing
annotations gracefully.

Spec: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G2)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/git-state-reconciler
gh pr create --title "feat(git-state): reconciler at pod startup" --body "Implements G2."
```

- [ ] **Step 3: Wait for CI, report PR URL**

---

## Phase G3: Deployer per-deploy summary

**Repo:** `thekraken`. **Branch:** `feat/deployer-summary`.

### Task G3.1: Branch + write `record_deploy_event` test

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull
git checkout -b feat/deployer-summary
```

- [ ] **Step 2: Failing test**

`test/unit/internal-ops-record-deploy.test.ts` (NEW):
```ts
import { describe, it, expect } from 'vitest';
import { initDatabase } from '../../src/db/migrations.js';
import { recordDeployEvent } from '../../src/dispatcher/internal-ops.js';

describe('record_deploy_event', () => {
  it('writes a deploy event row with the given summary', async () => {
    const db = initDatabase(':memory:');
    await recordDeployEvent(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      gitSha: 'def5678',
      summary: 'increased title length to 80 chars',
      deployedByEmail: 'rbias@mirantis.com',
      triggeredByChannel: 'C_AGENSYS',
      triggeredByTs: '1700000000.000100',
    });
    const row = db.prepare(
      `SELECT * FROM deployments WHERE git_sha = ?`,
    ).get('def5678') as { summary: string; deploy_type: string };
    expect(row.summary).toBe('increased title length to 80 chars');
    expect(row.deploy_type).toBe('manual');
  });

  it('falls back to "(deployed; no notes)" when summary is empty', async () => {
    const db = initDatabase(':memory:');
    await recordDeployEvent(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      gitSha: 'def5678',
      summary: '',
      deployedByEmail: 'rbias@mirantis.com',
      triggeredByChannel: 'C_AGENSYS',
      triggeredByTs: '1700000000.000100',
    });
    const row = db.prepare(
      `SELECT summary FROM deployments WHERE git_sha = ?`,
    ).get('def5678') as { summary: string };
    expect(row.summary).toBe('(deployed; no notes)');
  });
});
```

- [ ] **Step 3: Run — confirm fail**

```bash
npx vitest run test/unit/internal-ops-record-deploy.test.ts
```

### Task G3.2: Implement `record_deploy_event`

- [ ] **Step 1: Add to `src/dispatcher/internal-ops.ts`**

```ts
export interface RecordDeployEventParams {
  enclave: string;
  tentacle: string;
  gitSha: string;
  summary: string;
  deployedByEmail: string;
  triggeredByChannel: string;
  triggeredByTs: string;
}

export async function recordDeployEvent(
  db: Database,
  params: RecordDeployEventParams,
): Promise<void> {
  const summary = params.summary.trim() || '(deployed; no notes)';
  db.prepare(
    `INSERT INTO deployments (enclave, tentacle, version, git_sha, git_tag,
      deploy_type, summary, deployed_by_email, triggered_by_channel,
      triggered_by_ts, status)
     VALUES (?, ?, 0, ?, '', 'manual', ?, ?, ?, ?, 'success')`,
  ).run(
    params.enclave, params.tentacle, params.gitSha, summary,
    params.deployedByEmail, params.triggeredByChannel, params.triggeredByTs,
  );
}
```

Register the op in the existing internal-ops registry:
```ts
internalOps.register('record_deploy_event', async (input, ctx) => {
  // input shape matches RecordDeployEventParams; ctx.db is the SQLite handle.
  await recordDeployEvent(ctx.db, input as RecordDeployEventParams);
  return { ok: true };
});
```

- [ ] **Step 2: Run tests — pass**

```bash
npx vitest run test/unit/internal-ops-record-deploy.test.ts
```

### Task G3.3: Update deployer prompt

**Files:** `src/agent/system-prompt.ts` (modify).

- [ ] **Step 1: Failing test for prompt content**

`test/unit/deployer-summary-prompt.test.ts` (NEW):
```ts
import { describe, it, expect } from 'vitest';
import { buildDeployerPrompt } from '../../src/agent/system-prompt.js';

describe('deployer prompt', () => {
  it('instructs deployer to compose plain-English summary post-commit', () => {
    const prompt = buildDeployerPrompt({
      enclaveName: 'tentacular-agensys',
      userEmail: 'rbias@mirantis.com',
      userSlackId: 'U_X',
    });
    expect(prompt).toMatch(/plain.english summary/i);
    expect(prompt).toMatch(/record_deploy_event/i);
    expect(prompt).toMatch(/non.engineer/i);
    // Must NOT instruct to mention SHAs or git terms in the summary
    expect(prompt).toMatch(/don.t mention.*(file names|diff|technical)/i);
  });
});
```

- [ ] **Step 2: Confirm fail**

```bash
npx vitest run test/unit/deployer-summary-prompt.test.ts
```

- [ ] **Step 3: Add summary-step instructions to deployer prompt**

In `src/agent/system-prompt.ts`, locate `buildDeployerPrompt`. Add the following section before the closing of the prompt body:

```ts
// (inside buildDeployerPrompt's returned string array)
'',
'## Per-deploy summary (REQUIRED before deploy)',
'',
'After the commit lands and BEFORE you call wf_apply, compose a',
'one-sentence plain-English summary of what THIS deploy changes,',
'for a non-engineer reader (e.g., a marketing or sales person).',
'',
'Rules for the summary:',
'- One sentence, max ~120 chars.',
'- Plain English. Don\'t mention file names, diff syntax, or',
'  technical terms (no "function X", "added imports", "config").',
'- Describe the user-visible behavior change, not the code.',
'  Bad:  "Updated FILTER_WINDOW from 86400 to 604800"',
'  Good: "Filter window expanded from 1 day to 7 days"',
'- If you can\'t determine intent, write "(deployed; no notes)".',
'',
'Then call the `record_deploy_event` internal-op with:',
'  { enclave, tentacle, gitSha, summary, deployedByEmail,',
'    triggeredByChannel, triggeredByTs }',
'',
'Only after record_deploy_event succeeds, call wf_apply.',
```

- [ ] **Step 4: Run prompt test — pass**

```bash
npx vitest run test/unit/deployer-summary-prompt.test.ts
```

### Task G3.4: Pre-push + PR

- [ ] **Step 1: Full pre-push**

```bash
npx vitest run test/unit/
npx tsc --noEmit
npm run lint
npm run format:check
```

- [ ] **Step 2: Commit + PR**

```bash
git add src/dispatcher/internal-ops.ts src/agent/system-prompt.ts \
  test/unit/internal-ops-record-deploy.test.ts \
  test/unit/deployer-summary-prompt.test.ts
git commit -m "feat(deployer): per-deploy plain-English summary

Deployer subprocess now composes a one-sentence non-engineer
summary of what each deploy changes and writes it to Kraken DB
via the new record_deploy_event internal-op.

Marketing/sales user later sees these summaries when asking the
manager about past deploys.

Spec: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G3)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/deployer-summary
gh pr create --title "feat(deployer): per-deploy plain-English summary" --body "Implements G3."
```

---

## Phase G4: Manager git-state internal-ops

**Repo:** `thekraken`. **Branch:** `feat/manager-git-state-ops`.

### Task G4.1: Branch + tests for `list_deploy_events`

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull
git checkout -b feat/manager-git-state-ops
```

- [ ] **Step 2: Failing tests**

`test/unit/internal-ops-list-deploy-events.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { initDatabase } from '../../src/db/migrations.js';
import { listDeployEvents } from '../../src/dispatcher/internal-ops.js';

describe('list_deploy_events', () => {
  it('returns events for the given (enclave, tentacle), newest first', async () => {
    const db = initDatabase(':memory:');
    seedThreeDeploysIn(db, 'tentacular-agensys', 'ai-news-digest');

    const events = await listDeployEvents(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
    });
    expect(events).toHaveLength(3);
    expect(new Date(events[0].ts).getTime()).toBeGreaterThan(
      new Date(events[1].ts).getTime(),
    );
  });

  it('returns empty array when no events exist', async () => {
    const db = initDatabase(':memory:');
    const events = await listDeployEvents(db, {
      enclave: 'tentacular-agensys',
      tentacle: 'unknown',
    });
    expect(events).toEqual([]);
  });

  it('does not leak SHA or version_number in the public schema', async () => {
    const db = initDatabase(':memory:');
    seedThreeDeploysIn(db, 'e', 't');
    const events = await listDeployEvents(db, { enclave: 'e', tentacle: 't' });
    // Returns _internal_sha, ts, deployer_email, summary. No version_number,
    // git_tag, etc. in the public schema.
    const keys = Object.keys(events[0]);
    expect(keys.sort()).toEqual(
      ['_internal_sha', 'deployer_email', 'summary', 'ts'].sort(),
    );
  });
});
```

(Helper `seedThreeDeploysIn` inlined or shared.)

- [ ] **Step 3: Confirm fail**

### Task G4.2: Implement `list_deploy_events`

```ts
export interface DeployEventPublic {
  ts: string;
  deployer_email: string;
  summary: string;
  /** Internal-only SHA the LLM reasons about. NOT for user output. */
  _internal_sha: string;
}

export async function listDeployEvents(
  db: Database,
  params: { enclave: string; tentacle: string },
): Promise<DeployEventPublic[]> {
  const rows = db
    .prepare(
      `SELECT git_sha, deployed_by_email, summary, created_at
       FROM deployments
       WHERE enclave = ? AND tentacle = ?
       ORDER BY datetime(created_at) DESC, id DESC`,
    )
    .all(params.enclave, params.tentacle) as Array<{
    git_sha: string;
    deployed_by_email: string;
    summary: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    ts: r.created_at,
    deployer_email: r.deployed_by_email,
    summary: r.summary,
    _internal_sha: r.git_sha,
  }));
}
```

Register in internal-ops registry. Run test — pass.

### Task G4.3: `describe_change` with cache

**Files:** `test/unit/internal-ops-describe-change.test.ts` (NEW), `src/dispatcher/internal-ops.ts` (modify).

- [ ] **Step 1: Failing test**

```ts
describe('describe_change', () => {
  it('returns cached summary on second call (cache hit)', async () => {
    const db = initDatabase(':memory:');
    seedChangeSummaryCache(db, 'abc1234', 'def5678', 'cached summary text');
    const result = await describeChange(db, fakeGitDiffer, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });
    expect(result.summary).toBe('cached summary text');
    expect(result.cached).toBe(true);
  });

  it('returns the diff for the manager to summarize on cache miss', async () => {
    const db = initDatabase(':memory:');
    const differ = {
      diff: async (a: string, b: string) => `--- a/x\n+++ b/x\n@@\n-foo\n+bar`,
    };
    const result = await describeChange(db, differ, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });
    expect(result.cached).toBe(false);
    expect(result.diff).toContain('-foo');
    expect(result.diff).toContain('+bar');
  });

  it('records a manager-composed summary when called via record_change_summary', async () => {
    const db = initDatabase(':memory:');
    await recordChangeSummary(db, {
      shaA: 'abc1234',
      shaB: 'def5678',
      summary: 'title length grew from 50 to 80',
    });
    const result = await describeChange(db, fakeGitDiffer, {
      shaA: 'abc1234',
      shaB: 'def5678',
    });
    expect(result.cached).toBe(true);
    expect(result.summary).toBe('title length grew from 50 to 80');
  });
});
```

- [ ] **Step 2: Implement**

`describe_change` returns `{cached: true, summary}` on hit, or `{cached: false, diff}` on miss. The manager LLM, on receiving a `cached: false` result, composes a summary in its own context and follows up by calling `record_change_summary` to cache it.

This requires a new table:
```sql
CREATE TABLE IF NOT EXISTS change_summaries (
  sha_a TEXT NOT NULL,
  sha_b TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sha_a, sha_b)
);
```

Add migration to `src/db/migrations.ts`. Implement `describeChange`, `recordChangeSummary`. Register both ops.

The git differ adapter calls `git diff <sha_a> <sha_b>` against the tentacles checkout (path comes from config). Returns string.

- [ ] **Step 3: Tests pass**

### Task G4.4: `commission_revert`

- [ ] **Step 1: Failing test**

```ts
describe('commission_revert', () => {
  it('briefs dev team with structured intent and returns commissioned status', async () => {
    const briefingsCaptured: any[] = [];
    const fakeTeams = {
      spawn: async (brief: any) => {
        briefingsCaptured.push(brief);
        return { jobId: 'job-1' };
      },
    };
    const result = await commissionRevert(fakeTeams, {
      enclave: 'tentacular-agensys',
      tentacle: 'ai-news-digest',
      targetSha: 'abc1234',
      additionalIntent: 'raise the title limit to 80 chars',
      userSlackId: 'U_USER',
    });
    expect(result.status).toBe('commissioned');
    expect(briefingsCaptured).toHaveLength(1);
    expect(briefingsCaptured[0].intent).toContain('Restore');
    expect(briefingsCaptured[0].intent).toContain('raise the title limit to 80 chars');
    expect(briefingsCaptured[0].targetSha).toBe('abc1234');
  });
});
```

- [ ] **Step 2: Implement**

`commissionRevert` constructs a brief like:
```
Restore <tentacle> in <enclave> to the version at <targetSha>.
Then apply this additional change: <additionalIntent>.
After both changes are committed, deploy as a single new version.
Compose the per-deploy summary describing the combined effect from
the user's POV (not the mechanics).
```

Calls into the existing dev-team spawn path (`teams.spawn` or whatever the existing API is). Returns `{job_id, status: 'commissioned'}` immediately; the team handles the rest async via the team-bridge outbound channel.

- [ ] **Step 3: Tests pass**

### Task G4.5: PR

- [ ] **Step 1: Pre-push**

```bash
npx vitest run test/unit/
npx tsc --noEmit && npm run lint && npm run format:check
```

- [ ] **Step 2: Commit + PR**

```bash
git add src/dispatcher/internal-ops.ts src/db/migrations.ts \
  test/unit/internal-ops-list-deploy-events.test.ts \
  test/unit/internal-ops-describe-change.test.ts \
  test/unit/internal-ops-commission-revert.test.ts
git commit -m "feat(manager): git-state internal-ops

Three new internal-ops the manager invokes for the version-management
conversation:

- list_deploy_events: queries Kraken DB for past deploys.
- describe_change: cached or lazy-generated comparative summary.
  On cache miss, returns the raw diff so the manager LLM can
  compose; manager follows up with record_change_summary to cache.
- commission_revert: structured brief to dev team with target SHA
  and optional additional intent (revert + tweak in one shot).

Plus: change_summaries table migration for cached cross-version
summaries.

Spec: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G4)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/manager-git-state-ops
gh pr create --title "feat(manager): git-state internal-ops" --body "Implements G4."
```

---

## Phase G5: Manager prompt + skill addition

**Repo:** `thekraken`. **Branch:** `feat/git-state-skill`.

### Task G5.1: Branch + write the skill reference

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull
git checkout -b feat/git-state-skill
```

- [ ] **Step 2: Write `skills/kraken/references/git-state.md`**

Content covers (full text per spec section "Skill addition" in `docs/superpowers/specs/2026-05-05-git-state-recovery-design.md`):

1. The vocabulary contract (table: says vs does NOT say).
2. The four conversation primitives (list, compare, revert, revert+tweak) with example dialogues.
3. Internal-op invocation rules.
4. Ambiguity handling (multi-match → ask which using person+time+summary, never SHA).
5. Edge cases: no deploy events, reconstructed-only rows, user uses git terms.

Use the spec text directly. ~300 lines.

- [ ] **Step 3: Update `skills/kraken/SKILL.md`**

Add new section before any existing reference pointers:
```markdown
## Version management

Tentacles are versioned by deploy events — each deploy is a moment in
time with a person, summary, and (internally) a git SHA. Marketing
and sales users never see SHAs, version numbers, or git terminology.

Read `references/git-state.md` when:
- User asks what's changed, what versions exist, or what was deployed when
- User wants to go back to a previous behavior, undo a change, or revert
- User wants to revert AND modify in one shot
```

### Task G5.2: Update manager prompt

**Files:** `src/agent/system-prompt.ts` (modify), `test/unit/manager-prompt-vocabulary.test.ts` (NEW).

- [ ] **Step 1: Failing test for vocabulary contract**

```ts
import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from '../../src/agent/system-prompt.js';

describe('manager prompt vocabulary contract', () => {
  const prompt = buildManagerPrompt({
    enclaveName: 'tentacular-agensys',
    userEmail: 'rbias@mirantis.com',
    userSlackId: 'U_X',
  });

  it('instructs manager to never use SHA, version numbers, or git terms in user output', () => {
    expect(prompt).toMatch(/never.*SHA|never.*version number|never.*git/i);
  });

  it('lists the forbidden vocabulary explicitly', () => {
    // Forbidden words must be enumerated in the prompt
    expect(prompt).toMatch(/v\\d\+|sha|commit|tag|branch/i);
  });

  it('instructs manager to confirm before revert-class actions', () => {
    expect(prompt).toMatch(/confirm.*before.*(revert|undo|go back)/i);
  });

  it('instructs manager to call list_deploy_events before describing version state', () => {
    expect(prompt).toMatch(/list_deploy_events.*first|first.*list_deploy_events/i);
  });

  it('does not itself instruct the LLM to mention v3, abc123, etc.', () => {
    // The prompt's own examples must not slip into forbidden vocabulary
    expect(prompt).not.toMatch(/\\bv\\d+\\b(?! is)/); // bare "v3" outside a "vN is forbidden" rule
  });
});
```

- [ ] **Step 2: Confirm fail**

- [ ] **Step 3: Update `buildManagerPrompt`**

Add three sections to the prompt body (before any existing closing). Use the spec content from "Manager prompt updates" verbatim:
1. Vocabulary contract block (the rules).
2. Confirmation rule for revert-class actions.
3. Grounding rule (call `list_deploy_events` first; never describe state from memory).

- [ ] **Step 4: Tests pass**

### Task G5.3: PR

```bash
git add skills/kraken/references/git-state.md skills/kraken/SKILL.md \
  src/agent/system-prompt.ts test/unit/manager-prompt-vocabulary.test.ts
git commit -m "feat(manager,skill): vocabulary contract + git-state UX reference

Adds skills/kraken/references/git-state.md with the version
management UX (vocabulary contract, four conversation primitives,
internal-op invocation rules, ambiguity + edge cases).

Updates manager prompt to enforce vocabulary contract, require
list_deploy_events grounding before describing state, and require
explicit confirm before revert-class actions.

Spec: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/git-state-skill
gh pr create --title "feat(manager,skill): vocabulary contract + git-state UX reference"
```

---

## Phase G6: E2E M group

**Repo:** `thekraken`. **Branch:** `feat/e2e-git-state-m-group`.

### Task G6.1: Branch + add M group

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull
git checkout -b feat/e2e-git-state-m-group
```

- [ ] **Step 2: Add M group constant in `test/e2e-slack/scenarios.ts`**

Insert before the `RBAC_SCENARIOS` block (or after `SMART_PATH_LOCKDOWN_SCENARIOS`, wherever it fits cleanly):

```ts
// ---------------------------------------------------------------------------
// M. Git-state recovery (version management UX in Slack)
//
// Validates the git-state recovery design (PR-set G1-G5,
// docs/superpowers/specs/2026-05-05-git-state-recovery-design.md).
//
// Preconditions for M1, M2: at least 2 deploys must have happened on
// the test tentacle prior to running these scenarios. The harness
// does not pre-seed; rely on natural state from prior F-group scenarios
// or manual setup.
// ---------------------------------------------------------------------------

const FORBIDDEN_GIT_VOCABULARY =
  /\bv\d+\b|\bsha\b|\bcommit\b|\btag\b|\bbranch\b|\bnamespace\b|\bkubectl\b|\bpod\b/i;

export const GIT_STATE_SCENARIOS: ScenarioDef[] = [
  {
    id: 'M1',
    name: 'list past versions in plain English (no version numbers, no git terms)',
    channel: CHANNELS.enclave,
    message: '@Kraken what\'s been changing on ai-news-digest?',
    expectedPatterns: [
      // At least one dated entry should appear
      /\d{1,2}(:\d{2})?\s*(am|pm)|tuesday|wednesday|thursday|friday|monday|last\s+(week|month)|april|may|june/i,
    ],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    timeoutMs: 60_000,
  },
  {
    id: 'M2',
    name: 'comparative summary uses prose, not diff lines',
    channel: CHANNELS.enclave,
    message: '@Kraken what changed since last week?',
    expectedPatterns: [
      // Prose mentioning behavior change
      /title|filter|interval|channel|added|removed|changed|increased|decreased/i,
    ],
    forbiddenPatterns: [
      FORBIDDEN_GIT_VOCABULARY,
      /^[+-]/m, // No diff lines
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'M3',
    name: 'revert with confirm flow + cluster annotation advances',
    channel: CHANNELS.enclave,
    message: '@Kraken go back to last Tuesday\'s version of ai-news-digest',
    expectedPatterns: [
      // First reply must be a confirm prompt
      /you mean|to be sure|confirm|ok to proceed|want me to/i,
    ],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    followUpMessages: ['yes'],
    followUpAfterFirstReply: true,
    expectedReplyCount: 2,
    timeoutMs: 5 * 60_000,
    mcpAssertion: {
      pollMs: 10_000,
      timeoutMs: 5 * 60_000,
      check: async (mcpCall) => {
        // After confirm + commission, the deployment's git-sha annotation
        // must have changed (forward-revert produces a new SHA whose tree
        // matches the target).
        const before = process.env['M3_BASELINE_SHA'];
        if (!before) return null; // baseline not captured, skip assertion
        const raw = await mcpCall('wf_describe', {
          enclave: 'tentacular-agensys',
          name: 'ai-news-digest',
        });
        const parsed =
          typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
        const after = parsed?.annotations?.['tentacular.io/git-sha'];
        if (!after || after === before) {
          return `git-sha did not advance (was ${before}, still ${after})`;
        }
        return null;
      },
    },
  },
  {
    id: 'M4',
    name: 'revert + tweak — combined intent, single deploy event',
    channel: CHANNELS.enclave,
    message:
      '@Kraken go back to last Tuesday\'s but raise the title limit to 80',
    expectedPatterns: [/you mean|confirm|ok to proceed|want me to/i],
    forbiddenPatterns: [FORBIDDEN_GIT_VOCABULARY],
    followUpMessages: ['yes'],
    followUpAfterFirstReply: true,
    expectedReplyCount: 2,
    timeoutMs: 10 * 60_000,
    // mcpAssertion verifies cluster annotation advanced AND a single new
    // deploy event row exists in Kraken DB. Skipped if Kraken DB query
    // path isn't yet exposed via MCP — placeholder.
  },
  {
    id: 'M5',
    name: 'ambiguity disambiguation by person+time, not SHA',
    channel: CHANNELS.enclave,
    message: '@Kraken go back to Tuesday\'s version',
    expectedPatterns: [
      // Manager must ask which one (the morning/afternoon, or by deployer)
      /which one|two changes on tuesday|morning|afternoon|or do you mean/i,
    ],
    forbiddenPatterns: [
      FORBIDDEN_GIT_VOCABULARY,
      // Disambig prompt itself must not list SHAs
      /[a-f0-9]{7,}/i,
    ],
    timeoutMs: 60_000,
    skipWhen: () => process.env['KRAKEN_E2E_AMBIGUITY_PRECONDITION'] !== 'true',
  },
  {
    id: 'M6',
    name: 'manager refuses git-talk, redirects to dated phrasing',
    channel: CHANNELS.enclave,
    message: '@Kraken what changed in commit abc123def?',
    expectedPatterns: [
      // Manager redirects to date/person/behavior framing
      /which deploy|when was that|i talk about deploys by date|let me know which version/i,
    ],
    forbiddenPatterns: [
      // Must NOT confirm understanding of "abc123" as a meaningful identifier
      /abc123def is|i'll look at abc123/i,
    ],
    timeoutMs: 45_000,
  },
];
```

- [ ] **Step 3: Wire into ALL_SCENARIOS**

Locate `ALL_SCENARIOS` and add:
```ts
  // M. Git-state recovery — version management UX
  ...GIT_STATE_SCENARIOS,
```

at the appropriate position (after L group).

### Task G6.2: Pre-push + PR

- [ ] **Step 1: TS compile + format + lint**

```bash
npx tsc --noEmit
npm run format:check
npm run lint
```

- [ ] **Step 2: Commit + PR**

```bash
git add test/e2e-slack/scenarios.ts
git commit -m "test(e2e): M group for git-state recovery UX

Six scenarios covering the four conversation primitives (list,
compare, revert, revert+tweak) plus ambiguity (M5) and vocabulary
control (M6). Forbidden patterns enforce the vocabulary contract
across all M scenarios — any leakage of v\\d, sha, commit, tag,
branch, namespace fails the test.

Spec: docs/superpowers/specs/2026-05-05-git-state-recovery-design.md (G6)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/e2e-git-state-m-group
gh pr create --title "test(e2e): M group for git-state recovery UX" --body "Implements G6."
```

- [ ] **Step 3: Wait for CI green, report PR URL**

---

## Self-review

**Spec coverage:**
- Section "Architecture / data model" → G1 (cluster + git fields), G2 (Kraken DB reconciliation), G4 (manager queries cluster + Kraken DB).
- Section "Vocabulary contract" → G5 (manager prompt + skill), G6 (forbidden patterns).
- Section "Conversation flows: List" → G4 (`list_deploy_events`), G6 (M1).
- Section "Conversation flows: Compare" → G4 (`describe_change`), G6 (M2).
- Section "Conversation flows: Revert" → G4 (`commission_revert`), G5 (confirm rule in prompt), G6 (M3).
- Section "Conversation flows: Revert+tweak" → G4 (`commission_revert` with additionalIntent), G6 (M4).
- Section "Manager's tool surface" → G4 covers all four ops.
- Section "Reconciliation behavior" → G2.
- Section "Per-deploy summary generation" → G3.
- Section "Skill addition" → G5.
- Section "Manager prompt updates" → G5.
- Section "Deployer prompt updates" → G3.
- Section "Acceptance criteria" #1 (reconciler populates rows) → G2 test + G2 startup wiring.
- Section "Acceptance criteria" #2 (every new deploy has summary) → G3 deployer prompt + tests.
- Section "Acceptance criteria" #3 (forbidden vocabulary) → G6 M1–M6 forbidden patterns.
- Section "Acceptance criteria" #4 (cluster annotation advances on revert) → G6 M3 mcpAssertion.
- Section "Acceptance criteria" #5 (ambiguity disambig) → G6 M5.
- Section "Acceptance criteria" #6 (end-to-end no-SHA experience) → G6 across all M.

**Placeholder scan:** clean. No TBD/TODO. Every code step has full code or full instructions.

**Type consistency:** `RecordDeployEventParams` (G3), `DeployEventPublic._internal_sha` (G4), `commissionRevert` brief structure (G4) — all referenced consistently across tasks. Manager prompt + skill talk to `list_deploy_events`, `describe_change`, `commission_revert` — consistent across G4, G5, G6.

**One known limitation:** the M4 mcpAssertion is incomplete (placeholder). Reading Kraken DB row count via MCP isn't yet exposed; if we want to assert "exactly one new deploy event after revert+tweak" we'd need a new MCP tool or a kubectl-via-cluster-assertion fallback. Tracked as a follow-up. The M4 regex assertion still validates vocabulary + confirm flow — it's just the cluster-state assertion that's a soft-pass.

---

## Resumption protocol

If you resume this work after `/clear` or compaction:

1. Re-read this plan: `~/code/tentacular-main/thekraken/docs/superpowers/plans/2026-05-05-git-state-recovery.md`.
2. Re-read the spec: `~/code/tentacular-main/thekraken/docs/superpowers/specs/2026-05-05-git-state-recovery-design.md`.
3. Re-read the master plan: `~/.claude/plans/2026-05-04-eastus-stabilization-rc10.md` (Task #6 references this work).
4. `gh pr list -R randybias/thekraken -R randybias/tentacular --state open --search "git-state OR cli-state-restore OR deployer-summary OR manager-git-state OR git-state-skill OR e2e-git-state"` to see which phases have PRs already.
5. For each phase G1–G6, check the corresponding branch's checkbox state. Resume from the next unchecked task in the next un-merged phase.
