# Release remediation task ledger

## Bases and baseline

- Audited base: `7fa80049a6642d52a2d51d2515d96e37e6ae34af`.
- Implementation base: `e2d39abe86fe4c8afa0e4e28f4dab983679cb00a`.
- Task 0 baseline logs: `/tmp/pixel-pincher-release-baseline-e2d39ab`.
- Baseline on 2026-03-23: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint`, `pnpm test` (139 tests in 18 files), `pnpm build`, and `pnpm audit --prod` passed. `pnpm audit` reported the six recorded development-only WXT transitive advisories.

## Planned owners and commit order

| Task | Status | Owner and level | Branch or worktree | Changed files | Commit | Validation | Unresolved risks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | complete | Orchestrator, Level 1 | `main` | `docs/public-release-remediation-plan.md`, `docs/release-task-ledger.md` | `e2d39ab`, `6b752c7` | Baseline passed. Logs are outside the repository. | Full development audit has six WXT transitive advisories. Task 8 owns remediation. |
| 1 | complete | `qwen-worker`, Level 1 | managed isolated worktree | `README.md`, `docs/release-checklist.md` | `bd51d92` `docs: correct privacy release wording` | Parent reran check, lint, `tests/popup/popup-assets.test.ts`, and the required wording search. | Task 4 must verify credentials and referrer behavior. Store questionnaire remains a Task 10 manual gate. |
| 2 | complete | `worker`, Level 3 | managed isolated worktree | canonical parsers, callers, parser, popup, and repository tests | `07a5677` `refactor: canonicalize wire and storage parsers` | Parent reran repository and named Task 2 tests, check, lint, whitespace check, and no-wrapper search. Independent review found and the task repair included mutation snapshot preservation. | Task 6 owns remaining repository schema and compatibility-alias removal. |
| 3 | blocked by Task 2 | `worker`, Level 3 | isolated worktree after Task 2 | `src/content/control-panel.ts`, tests | pending `fix: preserve panel mutation intent` | Named content and coordinator tests; check and lint required. | Shares control panel with Tasks 4 and 5. |
| 4 | blocked by Task 1 | `worker`, Level 2 with Level 3 review | isolated worktree after Task 1 | control panel, helper, tests, `README.md` | pending `fix: bound and privatize URL imports` | Named tests; check and lint required. | CORS behavior and stream cancellation need review. |
| 5 | blocked by Tasks 3 and 4 | `worker`, Level 2 | same sequential control-panel owner worktree | control panel and tests | pending `fix: clean panel lifecycle` | Named tests; check and lint required. | Depends on typed send result. |
| 6 | blocked by Task 2 | `worker`, Level 3 | isolated worktree after Task 2 | repository, storage, keys, contracts, parsers, tests | pending `refactor: add index v2 and corruption-tolerant purge` | Named repository suite, searches, check, and lint required. | Storage migration and deletion recovery. |
| 7 | blocked by Tasks 2, 4, 5, and 6 | `worker`, Level 3 | isolated worktree after dependencies | popup, importer, repository, tests, `docs/plan.md` | pending `refactor: remove dead popup and page records` | Full suite, build, and obsolete-reference search required. | Deletions must not remove required popup gates. |
| 8 | assigned | `terra-validator`, Level 1 and Level 2 dependency update scope | isolated worktree | CI, build assertion, package files, lockfile | pending `build: harden CI and package assertions` | Full baseline, audit, action-reference scan required. | The initial `qwen-worker` attempt timed out before tracked changes. Compatible WXT upgrade and any dated audit exception remain. |
| 9 | blocked by Tasks 1 through 8 | `sol-reviewer`, independent validator | clean integration worktree | review evidence and only confirmed fixes | pending | Full automated suite, package inspection, security and maintainability review. | Must repeat after any confirmed blocker or high finding. |
| 10 | blocked by Task 9 | `terra-validator`, independent validator | exact clean release build | release checklist and external draft archive only | pending | Manual browser matrix and store evidence required. | Browser control and store credentials may be unavailable. |
| 11 | blocked by Task 10 | Orchestrator | `main` | final release report | pending | All prior evidence required. | `NO-SHIP` if any gate lacks evidence. |
