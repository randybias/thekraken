# Phase 4: Polish + Deploy — Tasks

**Change ID:** phase4-polish-deploy
**Status:** COMPLETE

---

## Implementation Order

Tasks were executed sequentially. Each step had to pass
`npm test && npx tsc --noEmit && npm run lint && npm run format:check`
before the next step began.

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | OpenSpec artifacts | `openspec/changes/phase4-polish-deploy/` | DONE |
| 2 | D1: Block Kit formatter | `src/slack/formatter.ts`, `test/unit/slack-formatter.test.ts` | DONE |
| 3 | D2: Structured cards | `src/slack/cards.ts`, `test/unit/slack-cards.test.ts` | DONE |
| 4 | D3: Home Tab | `src/slack/home-tab.ts`, `test/unit/slack-home-tab.test.ts` | DONE |
| 5 | D4: Deploy flow | `src/git-state/deploy.ts`, `src/git-state/deployments-db.ts`, tests | DONE |
| 6 | D5: Rollback flow | `src/git-state/rollback.ts`, `test/unit/rollback.test.ts` | DONE |
| 7 | D6: Drift detection wiring | `src/index.ts` | DONE |
| 8 | D7: Codex fixes (a/b/c) | `src/dispatcher/router.ts`, `src/slack/bot.ts`, `test/unit/codex-phase4-fixes.test.ts` | DONE |
| 9 | D8: Docs | `README.md`, `CLAUDE.md`, `charts/thekraken/README.md`, openspec | DONE |
| 10 | Pipeline validation | All files | DONE |

## Test Coverage Added

| Test File | Tests | Coverage |
|-----------|-------|---------|
| `test/unit/slack-formatter.test.ts` | 14 | D1: formatter pure functions |
| `test/unit/slack-cards.test.ts` | 18 | D2: all four card builders + dispatcher |
| `test/unit/slack-home-tab.test.ts` | 14 | D3: buildHomeTab + buildUnauthenticatedHomeTab |
| `test/unit/deploy.test.ts` | 14 | D4: validateExplanation, readVersionFromWorkflow, deploy() |
| `test/unit/deployments-db.test.ts` | 11 | D4: DeploymentDb all methods |
| `test/unit/rollback.test.ts` | 11 | D5: rollback() success/failure paths |
| `test/unit/codex-phase4-fixes.test.ts` | 17 | D7(a/b/c): router and parser |

**Total tests Phase 4:** 99 new tests (625 before → 742 after, +117 across all phases 3-4)
