# The Kraken v2 — OpenSpec Project Configuration

## Change Naming Convention

Changes are named with phase-based slugs:

- `phase0-scaffold` — Scaffold + test harness + git-state infra port
- `phase1-core-loop` — Core loop (Slack + pi Agent + MCP + enclave binding)
- `phase2-auth-authz` — Auth + authz (OIDC device flow + POSIX + tool scoping)
- `phase3-commands-events` — Commands + channel events + personas
- `phase4-polish-deploy` — Polish + deploy (Block Kit, Home Tab, Helm, values overlay)
- `phase5-hardening` — Hardening (restart resilience, rate limits, observability)

Cross-repo changes use descriptive slugs: `wf-apply-requires-version`.

## Required Artifacts Per Change

Every OpenSpec change directory must contain:

| File | Owner | Required |
|------|-------|----------|
| `proposal.md` | Product Manager | Yes |
| `design.md` | Architect | Yes |
| `tasks.md` | Product Manager | Yes |
| `.openspec.yaml` | Auto-generated | Yes |
| `specs/**/spec.md` | Developer | If specs exist |

## Review Gates

Each change must pass ALL of the following before merge:

1. **Code Review** — Senior Developer or Code Reviewer. Correctness,
   completeness, maintainability.
2. **Security Review** — Senior Security Architect. Auth flows, credential
   handling, tool scoping, git operations.
3. **QA Review** — Senior QA Engineer. Test coverage, no flaky tests, scenario
   coverage where applicable.
4. **Tech Writer Review** — Senior Technical Writer. README, CLAUDE.md, skill
   docs, JSDoc quality.
5. **Codex Review** — Automated (skippable if MCP unreachable; log reason +
   timestamp in tasks.md).

## Branch Naming

```
feature/<change-slug>
```

Examples: `feature/phase0-scaffold`, `feature/phase1-core-loop`.

## Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
feat: add SQLite schema for v2 tables
fix: handle missing GIT_STATE_REPO_URL in entrypoint
test: add AIMock smoke tests
chore: configure eslint + prettier for v2
docs: add Phase 0 design document
```

## Pre-Push Gates

Every developer must pass before pushing:

```bash
npm test && npx tsc --noEmit && npm run lint && npm run format:check
```

For shell scripts:

```bash
shellcheck scripts/entrypoint.sh kraken-hooks/pre-commit
```

For Helm chart:

```bash
helm lint charts/thekraken --set gitState.repoUrl=https://github.com/test/repo.git --set gitState.credentialsSecret=test-secret
```

## Definition of Done (Per Change)

- [ ] OpenSpec artifacts consistent (proposal, design, tasks)
- [ ] Code implemented and committed (Conventional Commits)
- [ ] Code Reviewer sign-off
- [ ] Security Architect sign-off
- [ ] QA Engineer sign-off
- [ ] Tech Writer sign-off
- [ ] Codex review run (or skipped with reason + timestamp logged)
- [ ] Tests pass: `npm test && npx tsc --noEmit && npm run lint && npm run format:check`
- [ ] `helm lint` passes
- [ ] `shellcheck` passes

## OpenSpec Change Directory Structure

```
openspec/
  project.md          # This file
  changes/
    phase0-scaffold/
      proposal.md     # PM: why, what, acceptance criteria
      design.md       # Architect: interfaces, SQL, exact file contents
      tasks.md        # PM: numbered tasks, DoD per task
      .openspec.yaml  # Auto-generated metadata
```
