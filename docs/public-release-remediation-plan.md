# Public-release remediation plan

## Status

This plan is ready for orchestration against audited commit `7fa8004`. Complete the tasks in dependency order. Keep each task in a separate commit unless the task says to combine work.

At handoff, this file may be the only untracked path. If so, commit it as a documentation-only handoff before Task 0. Record `7fa8004` as the audited base and the documentation commit as the implementation base.

The release remains blocked until every required task and release gate in this plan passes.

## Goal

Prepare Pixel Pincher 0.1.0 for a public Chromium release. Preserve these product rules:

- Site access stays optional and exact-origin.
- The content script runs only in the top frame.
- Reference images and settings stay in `chrome.storage.local`.
- The extension sends no telemetry and uploads no images.
- A network request occurs only when the user imports an HTTP or HTTPS image URL.
- A clear or permission-revocation operation removes all data owned by that origin, including corrupt or orphaned image records.
- Source images stay limited to 10 MiB, encoded images to 14 MiB, and decoded images to 40 million pixels.
- The popup only grants access, reports status, repairs corrupt data, and shows or hides the in-page panel. The in-page panel owns reference and overlay controls.

Do not add a UI framework, telemetry, a server, broad required host permissions, iframe injection, incognito support, or compatibility code for an unpublished release.

## Baseline evidence

The audit at `7fa8004` produced these results:

- `pnpm check` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 139 tests in 18 files.
- `pnpm build` passed and produced 10 files totaling about 119 kB.
- `pnpm audit --prod` found no production vulnerabilities.
- A full `pnpm audit` found six development-only transitive advisories through WXT.
- The generated manifest had no required host permissions, had exact optional HTTP and HTTPS hosts, disabled incognito, and had no static content script.
- No exploitable HTML injection, executable SVG sink, telemetry, cross-origin storage access, secret, or unauthorized message path was confirmed.

Do not weaken the existing message parsing, sender checks, origin checks, runtime-registration checks, or image validation while completing this plan.

## Severity and release policy

Use these priorities:

- `P0`: release policy or user-data defect. Fix before any public submission.
- `P1`: reachable correctness, resource, or reliability defect. Fix before the release candidate.
- `P2`: maintainability or release-engineering defect. Fix before the release candidate unless this plan marks it optional.
- `Gate`: evidence that must exist for the exact release archive. Never infer a gate from unit tests.

## Agent levels

The orchestrator assigns work by these levels:

| Level | Suitable work |
| --- | --- |
| Level 1, scoped implementer | Documentation, small scripts, narrow tests, and mechanical cleanup with named files and exact acceptance checks. |
| Level 2, product engineer | Local TypeScript changes with tests, DOM behavior, fetch and stream handling, and build configuration. |
| Level 3, senior engineer | Cross-module contracts, asynchronous state machines, persistent-data design, corruption recovery, and migrations. |
| Independent validator | Read-only review, complete command validation, package inspection, and manual browser execution when browser control is available. |

A Level 1 agent must not redesign a protocol or persistence model. A Level 2 agent must escalate any required contract change to the orchestrator. Assign Tasks 2 and 6 only to Level 3 agents.

## Orchestration rules

1. Start from a clean worktree at `7fa8004` or rebase this plan onto the current `main` and record the new base commit.
2. Run the baseline commands before edits. Stop if a baseline command fails for a reason not recorded above.
3. Use one writer for each file at a time. Use separate worktrees for parallel writers.
4. Do not merge parallel branches by copying whole files. Rebase or cherry-pick task commits in dependency order and resolve changes at the symbol level.
5. Require the task-specific tests before accepting a task commit.
6. After each merge, run `pnpm check`, `pnpm lint`, and the affected test files.
7. After Tasks 1 through 9, run the complete verification suite and an independent security and maintainability review.
8. Do not mark manual browser rows as passed unless an operator used the exact release directory or archive and recorded the observed result.
9. Keep the worktree clean between tasks. Do not commit `dist/`, `.wxt/`, coverage output, editor files, or audit artifacts.

## Dependency graph

```text
Task 0: baseline and work allocation
  |-- Task 1: privacy and release wording --> Task 4: bounded URL import --------|
  |-- Task 2: canonical parsers -------------------------------------------------+--> Task 9: final automated verification
  |      |-- Task 3: panel mutation state --> Task 5: panel lifecycle -----------|
  |      `-- Task 6: repository data model and purge ----------------------------|
  |             `-- Task 7: remove dead models and popup code -------------------|
  `-- Task 8: CI, package assertions, and toolchain -----------------------------|

Task 9 --> Task 10: exact release package and browser matrix
Task 10 --> Task 11: final handoff and ship decision
```

Tasks 1, 2, and 8 may begin in parallel in separate worktrees. Start Task 4 after Task 1 because both tasks update the README. Tasks 3 and 6 require Task 2. Start Task 7 only after Tasks 2, 4, 5, and 6 are integrated. The orchestrator may assign Tasks 3, 4, and 5 to one Level 3 owner because they touch `src/content/control-panel.ts`, but the owner must keep three separate commits.

## Task 0: establish the baseline and assign owners

**Priority:** Gate  
**Difficulty:** Level 1  
**Dependencies:** none

### Work

1. If `docs/public-release-remediation-plan.md` is the only untracked path, commit it with message `docs: add public release remediation plan`.
2. Record the audited and implementation base commits. Confirm that the worktree is clean.
3. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm lint
   pnpm test
   pnpm build
   pnpm audit --prod
   pnpm audit || true
   ```

4. Save command logs outside the tracked source tree or in the release record location chosen by the operator.
5. Assign one owner to each task. Record each owner, branch or worktree, and planned commit order.
6. Inspect `package.json`, `wxt.config.ts`, `dist/chrome-mv3/manifest.json`, and `git status --short` before implementation starts.

### Acceptance

- The base commit is recorded.
- The worktree is clean.
- Baseline results either match this plan or the orchestrator records the difference and updates the plan before implementation.
- Every task has one named owner.

## Task 1: correct privacy and release wording

**Priority:** P0  
**Difficulty:** Level 1  
**Dependencies:** Task 0  
**Primary files:** `README.md`, `docs/release-checklist.md`, optional Chrome Web Store listing draft

### Defect

`docs/release-checklist.md` tells the release operator to state that the extension makes no network requests. `ControlPanel.#importImageUrl` fetches a user-entered HTTP or HTTPS URL. The README already describes the exception.

### Work

1. Replace the false statement in `docs/release-checklist.md` with this meaning:
   - Pixel Pincher sends no telemetry.
   - Pixel Pincher does not upload images or page content.
   - When the user submits an HTTP or HTTPS image URL, Pixel Pincher requests that URL.
   - The selected server receives normal network metadata for that request.
   - Pixel Pincher stores the validated image bytes only in `chrome.storage.local`.
2. Make the README use the same terms. Use "URL import request" consistently.
3. Add a release-checklist item that compares the implementation, README, store listing, and privacy questionnaire before submission.
4. Add a checklist item that verifies URL imports use omitted credentials and no referrer after Task 4.
5. Do not claim that a `blob:` or `data:` import makes a remote request.
6. If the repository contains a store listing draft, update it. If it does not, add the final disclosure text to the release checklist for the operator to copy.

### Tests

Run:

```sh
pnpm test -- tests/popup/popup-assets.test.ts
rg -n "no network requests|telemetry|upload|image URL|URL import" README.md docs
```

Update documentation assertions when they encode the old false statement.

### Acceptance

- No release instruction says that the extension makes no network requests.
- README and release-checklist statements agree.
- The wording distinguishes user-directed URL requests from telemetry and uploads.
- Existing privacy claims remain narrow enough to verify from source.

## Task 2: make the current wire and storage schemas canonical

**Priority:** P1  
**Difficulty:** Level 3  
**Dependencies:** Task 0  
**Primary files:** `src/shared/parse.ts`, `src/shared/panel-position.ts`, `src/shared/contracts.ts`, parser tests, popup controller tests

### Defect

`OverlaySnapshot` and `OriginRecordV1` contain optional panel and site placement fields, but the original parsers reject those keys. Wrapper parsers in `src/shared/panel-position.ts` remove the fields, call a legacy parser, and reconstruct the value. `PopupController.#sendSnapshot` calls the legacy parser and rejects valid mutation responses that contain `panelPosition`.

### Target design

Use one parser for each domain type:

```ts
parsePanelPosition(value: unknown): Result<PanelPosition, PublicError>
parseOriginRecordV1(value: unknown): Result<OriginRecordV1, PublicError>
parseOverlaySnapshot(value: unknown): Result<OverlaySnapshot, PublicError>
parseHydration(value: unknown): Result<Hydration, PublicError>
parseTabState(value: unknown): Result<TabState, PublicError>
parseContentRequest(value: unknown): Result<ContentRequest, PublicError>
```

Each parser accepts the current schema directly. Strict key checking remains in place. For optional fields, accept exactly the valid key combinations and reject all unknown keys.

After this task:

- `parseOverlaySnapshot` accepts an absent or valid `panelPosition`.
- `parseOriginRecordV1` accepts absent or valid `placement` and `panelPosition` fields.
- `parseHydration`, `parseTabState`, and `parseContentRequest` use the canonical snapshot parser.
- `src/shared/panel-position.ts` keeps only panel-specific request and response parsing that is not part of the general parser module.
- Delete `parseOriginRecordWithPanelPosition`, `parseOverlaySnapshotWithPanelPosition`, `parseTabStateWithPanelPosition`, `parseHydrationWithPanelPosition`, and `parseContentRequestWithPanelPosition`.
- All callers import canonical parser names.

Do not loosen prototype checks, own-property checks, integer bounds, exact-key checks, origin and page-key checks, MIME checks, or encoded-size checks.

### Work

1. Move panel-position value parsing into `src/shared/parse.ts` or another neutral parser module that owns the domain type.
2. Update the canonical record and snapshot parsers to parse optional fields without deleting object properties or rebuilding legacy objects.
3. Update all nested parsers to call the canonical functions.
4. Update imports in popup, content, repository, and entrypoint modules.
5. Delete the wrapper parser functions and duplicate record-shape helpers from `src/shared/panel-position.ts`.
6. Update tests to cover every valid optional-key combination and unknown-key rejection.
7. Add popup controller regression tests for these responses containing `panelPosition`:
   - a successful registration response;
   - a successful `replace-reference` response if that route remains until Task 7;
   - a successful `update-settings` response if that route remains until Task 7.

### Tests

Run:

```sh
pnpm test -- tests/shared/parse.test.ts tests/shared/panel-position.test.ts tests/popup/popup-controller.test.ts tests/content/overlay.content.test.ts
pnpm check
pnpm lint
rg -n "WithPanelPosition" src tests
```

The last command must return no source or test references.

### Acceptance

- Every valid snapshot with `panelPosition` parses through `parseOverlaySnapshot`.
- Every valid snapshot without `panelPosition` still parses.
- Unknown keys still fail.
- Popup mutation responses no longer report `invalid-request` because `panelPosition` is present.
- No wrapper strips fields before parsing.
- `pnpm check`, lint, and the named tests pass.

## Task 3: make panel mutations preserve intended state

**Priority:** P1  
**Difficulty:** Level 3  
**Dependencies:** Task 2  
**Primary files:** `src/content/control-panel.ts`, `tests/content/control-panel.test.ts`

### Defect

`ControlPanel.#commitNumber` builds placement patches from the last confirmed snapshot. If the user changes X and then Y before the X request returns, the queued Y patch contains the old X value and overwrites the first change.

### Target design

Track intended compound values across a request round trip:

```ts
type PanelMutationResult =
  | Readonly<{ ok: true; snapshot?: OverlaySnapshot }>
  | Readonly<{ ok: false }>;

#placementIntent: Placement | undefined;
#currentPlacement(): Placement;
#send(request: PanelRequest): Promise<PanelMutationResult>;
```

Use `#placementIntent` when constructing the next placement patch. Update the intent before queueing the request. A queued patch must contain all changes the user made before the earlier request completed.

On a failed request:

- stop the settings queue;
- clear queued settings and intents;
- render the last confirmed snapshot;
- keep the error visible.

On a successful request, apply the returned snapshot. Do not clear an intent if a queued patch still depends on it. It is acceptable to clear the intent after the queue drains and the last returned snapshot contains the intended value.

### Work

1. Change `#send` to return a typed success or failure result.
2. Add placement-intent state and a helper that returns intended placement before confirmed placement.
3. Build X and Y patches from the intended placement.
4. Make queue failure behavior explicit. Do not dispatch later patches after a failed mutation.
5. Keep opacity and sizing coalescing behavior unchanged.
6. Add a deferred-request test:
   - start from `{x: 10, y: 20}`;
   - enter X `12` and hold the response;
   - enter Y `30` before resolving X;
   - resolve X with `{x: 12, y: 20}`;
   - assert that the queued request contains `{x: 12, y: 30}`;
   - resolve Y and assert that the final rendered state is `{x: 12, y: 30}`.
7. Add a failure test that confirms the queue stops and the controls return to the last confirmed snapshot.

### Tests

Run:

```sh
pnpm test -- tests/content/control-panel.test.ts tests/background/coordinator.test.ts
pnpm check
pnpm lint
```

### Acceptance

- Rapid X and Y edits preserve both values.
- Failed mutations do not dispatch stale queued patches.
- The UI returns to confirmed state after a failure.
- Coalesced opacity and scale updates still work.

## Task 4: bound and privatize URL import requests

**Priority:** P1  
**Difficulty:** Level 2 with a Level 3 review  
**Dependencies:** Task 1  
**Primary files:** `src/content/control-panel.ts`, a new content import helper, content tests, README

### Defect

`ControlPanel.#importImageUrl` buffers the full response before applying the 10 MiB source limit. A large or endless response can consume renderer memory. Failed imports also log the complete URL. The URL field has no visible mouse or touch submission action.

### Target design

Create a content-owned helper. Do not put browser fetch logic in the pure image-import service.

```ts
type ReadBoundedResponseResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; reason: "too-large" | "read-failed" }>;

readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<ReadBoundedResponseResult>;
```

The helper must:

1. Reject a valid `Content-Length` greater than `MAX_IMAGE_RAW_BYTES` before reading.
2. Read `response.body` through a stream reader.
3. Track the cumulative byte count.
4. Call `reader.cancel()` and return `too-large` as soon as the count exceeds the limit.
5. Store chunks and allocate the final array once after the total is known. Do not concatenate the full buffer for every chunk.
6. Fail closed when no readable body is available.

Fetch URL imports with:

```ts
fetch(url, {
  credentials: "omit",
  referrerPolicy: "no-referrer",
});
```

Do not add host permissions for remote image servers. Existing CORS behavior remains part of the feature.

### Work

1. Add the bounded-response helper under `src/content/`.
2. Use the helper before creating a `File`.
3. Map `too-large` to the existing `image-too-large` public error.
4. Keep MIME sniffing, declared MIME matching, pixel limits, and encoded limits in the pure importer.
5. Remove complete-URL logging. If diagnostics need a source label, log only `http://host`, `https://host`, `blob`, or `data` without credentials, path, query, fragment, or payload.
6. Add a labeled **Import URL** button next to the URL field. Put the field and button in a form so Enter and button activation use one submit handler.
7. Keep paste-to-import behavior.
8. Update README instructions to name the button and Enter behavior.
9. Add tests for:
   - a declared length above 10 MiB;
   - chunked data that crosses the limit;
   - cancellation after crossing the limit;
   - an allowed response exactly at the limit;
   - a missing body;
   - `credentials: "omit"` and `referrerPolicy: "no-referrer"`;
   - button submission;
   - Enter submission;
   - no full URL in an error log.

### Tests

Run:

```sh
pnpm test -- tests/content/control-panel.test.ts tests/popup/import-reference.test.ts
pnpm check
pnpm lint
```

### Acceptance

- URL import never buffers more than 10 MiB plus one incoming stream chunk.
- The code cancels an oversized stream.
- URL requests omit credentials and referrer data.
- Diagnostics contain no path, query, fragment, credentials, or data payload.
- Keyboard, mouse, and touch users have a discoverable submit action.
- Local file import behavior and limits remain unchanged.

## Task 5: clean up panel lifecycle and failed optimistic state

**Priority:** P2  
**Difficulty:** Level 2  
**Dependencies:** Tasks 3 and 4  
**Primary files:** `src/content/control-panel.ts`, `tests/content/control-panel.test.ts`

### Defects

- `ControlPanel.destroy()` leaves global `resize` and `keydown` listeners attached.
- Image replacement previews a new image before persistence succeeds.
- Hiding the panel proceeds even when the settings mutation fails.
- Callers cannot distinguish a successful `#send` from a failed request.

### Work

1. Use the typed `#send` result from Task 3.
2. Apply preview and visibility state only from a successful returned snapshot.
3. If temporary preview state is necessary during decoding, retain the previous data URL and restore it when the mutation fails.
4. Do not hide the panel after a failed visibility update.
5. Remove every global listener in `destroy()`.
6. Clear pending settings, intents, and references that can retain the destroyed panel.
7. Make `destroy()` idempotent.
8. Add tests that dispatch `resize` and `keydown` after destruction and prove that no handler changes state.
9. Add failed replacement and failed visibility tests.

### Tests

Run:

```sh
pnpm test -- tests/content/control-panel.test.ts tests/content/overlay-entrypoint.test.ts
pnpm check
pnpm lint
```

### Acceptance

- Destruction removes global listeners and retained queues.
- A failed replacement does not leave an unpersisted preview.
- A failed hide request leaves the panel visible and reports the error.
- Calling `destroy()` twice is safe.

## Task 6: make repository reads cheap and deletion corruption tolerant

**Priority:** P0 for deletion, P1 for routine read cost  
**Difficulty:** Level 3  
**Dependencies:** Task 2  
**Primary files:** `src/background/repository.ts`, `src/background/storage-adapter.ts`, `src/shared/keys.ts`, `src/shared/contracts.ts`, parsers, repository and site-access tests

### Defects

- Routine ownership checks call `chrome.storage.local.get()` without keys and materialize every image payload.
- `clearOrigin` cannot identify the target image when the target origin record is corrupt.
- `listOrigins`, orphan cleanup, and site-access reconciliation can stop on malformed data and leave revoked-origin bytes behind.

### Required design

Keep image payloads out of routine metadata reads. Extend the storage index so it records enough metadata to find image ownership without loading image values.

Use a new index schema. The exact property names may follow existing conventions, but the shape must carry these facts:

```ts
type OriginIndexV2 = Readonly<{
  schemaVersion: 2;
  origins: readonly Readonly<{
    origin: Origin;
    referenceId: ReferenceId | null;
  }>[];
  imageIds: readonly ReferenceId[];
}>;
```

Rules:

- Sort origins by origin string and image IDs by ID before writing.
- Reject duplicate origins, duplicate image IDs, and one image owned by two origins.
- Write a new image record and its index membership in one `storage.set` call.
- Write an origin record and its owner entry in one `storage.set` call.
- Remove an old image record and its image-index entry during the same logical replacement operation.
- Normal `readSnapshot`, ownership validation, `listOrigins`, and valid-origin clear paths read only the index and named origin or image keys. They must not call `readAll()`.
- `readHydration` may read the one image key named by the origin record.
- Reserve `readAll()` for a one-time V1 index migration and explicit corruption-recovery purge.

Because 0.1.0 has not been publicly released, do not preserve the obsolete page-record model. Task 7 removes it. The V1-to-V2 migration only needs to preserve valid current origin records and image records.

### Corruption-recovery purge

Add a separate operation for deletion when normal parsing fails:

```ts
purgeOrigin(origin: Origin): Promise<Result<void, RepositoryError>>;
```

`purgeOrigin` must prefer the V2 index. If the index or target record is malformed, it may use `readAll()` because the user requested deletion or permission was revoked.

The fallback algorithm is:

1. Read all storage once.
2. Parse every valid non-target origin record independently. One malformed record must not stop the pass.
3. Build the set of image IDs referenced by valid non-target origins.
4. Remove the target origin key and every obsolete page key for that origin.
5. Remove every image key that no valid non-target origin references when either the V2 index associates it with the target or the record is otherwise orphaned.
6. Preserve image records referenced by a valid non-target origin.
7. Rebuild a valid V2 index from the records that remain.
8. Return success only after the removals and index write complete.

If an image is ambiguously owned by two valid non-target records, preserve it and return `invalid-stored-data` after removing data that is unambiguously owned by the target. Privacy deletion takes precedence over repairing unrelated corrupt state.

Use `purgeOrigin` for:

- the user-facing clear operation;
- `chrome.permissions.onRemoved` cleanup;
- startup reconciliation of a stored origin without permission.

### Work

1. Add V2 index types, parser, and key helpers.
2. Implement one-time V1 index migration. Seed `imageIds` from named image keys during this migration only.
3. Replace routine `readAll()` ownership checks with index and targeted origin reads.
4. Implement `purgeOrigin` and use it at all deletion boundaries.
5. Keep per-origin serialization and the maintenance lock.
6. Ensure that replacement rollback updates both records and index state.
7. Delete compatibility aliases `getSnapshot`, `hydrate`, and `removeOrphans` after callers and tests use canonical names.
8. Add tests for:
   - routine snapshot reads with several 14 MiB image records, asserting that no full-store read occurs;
   - V1-to-V2 migration;
   - valid replacement and old-image deletion;
   - a corrupt target origin with a real image record;
   - a corrupt index;
   - another valid origin that owns an image which must survive;
   - permission revocation with corrupt target data;
   - idempotent purge after partial prior cleanup;
   - storage failure during each write and remove phase.

### Tests

Run:

```sh
pnpm test -- tests/background/repository.test.ts tests/background/site-access.test.ts tests/background/coordinator.test.ts tests/background/storage-adapter.test.ts tests/shared/parse.test.ts tests/shared/keys.test.ts
pnpm check
pnpm lint
```

Inspect the implementation:

```sh
rg -n "readAll\(" src/background
rg -n "getSnapshot|removeOrphans|async hydrate\(" src tests
```

Every remaining `readAll()` call must be in the documented migration or purge path. The compatibility-alias search must return no matches.

### Acceptance

- Routine reads never materialize unrelated image payloads.
- Clearing and permission revocation remove target data even when its origin record or index is corrupt.
- Valid unrelated images survive recovery.
- Repeating purge converges on the same state.
- V1 data migrates once, and normal operations use V2 afterward.
- Repository and site-access tests cover partial failures.

## Task 7: remove dead popup and page-record models

**Priority:** P2  
**Difficulty:** Level 3  
**Dependencies:** Tasks 2, 4, 5, and 6  
**Primary files:** `entrypoints/popup/main.ts`, `src/popup/popup-controller.ts`, `src/popup/import-reference.ts`, `src/shared/*`, `src/background/repository.ts`, popup and repository tests, `docs/plan.md`

### Defects

- The shipped popup contains unreachable reference and settings controls. The dead controls have already drifted from the 600% scale contract.
- Content code imports a pure image service from the popup directory.
- The obsolete page-record model is still parsed and can invalidate otherwise usable origin data.
- `docs/plan.md` describes old popup and page-record responsibilities.

### Work

1. Move the pure import service from `src/popup/import-reference.ts` to `src/shared/image-import.ts` or `src/image/import-reference.ts`.
2. Keep the service free of DOM, Chrome, WXT, and fetch dependencies.
3. Move its tests to the matching neutral test path and update content imports.
4. Delete the unreachable `controls()` renderer and popup event handlers for image replacement, settings, placement, and ordinary clear controls.
5. Keep only these popup operations:
   - load active-tab state;
   - request exact-origin permission from the user gesture;
   - register or repair the runtime content script;
   - retry after an error;
   - clear corrupt site data;
   - show or hide the in-page panel.
6. Remove dead `PopupController` methods, adapter methods, state, imports, CSS, and tests.
7. Delete `PageRecordV1`, page-record parsing, page-key storage reads, and page-record write or cleanup logic.
8. During repository cleanup, remove all `pixel-pincher:page:` keys. No page-record migration is required because 0.1.0 has not been publicly released and current origin records already carry site placement.
9. Update `docs/plan.md` architecture, domain model, persistence records, and popup responsibilities to describe the code that remains.
10. Remove unused exports and dependencies reported by `knip` when they belong to the deleted paths. Do not perform unrelated cleanup.

### Tests

Run:

```sh
pnpm test
pnpm check
pnpm lint
pnpm build
rg -n "PageRecordV1|pageRecordKey|parsePageRecord|function controls\(|MAX_SCALE_PERCENT.*400|src/popup/import-reference" src entrypoints tests docs
```

The search must return no obsolete implementation references. Historical text may remain only when clearly labeled as history.

### Acceptance

- Popup behavior is limited to the listed operations.
- The pure importer lives in a neutral module.
- Content and popup code do not import each other.
- No page record can invalidate a snapshot.
- The generated popup still opens and can enable, retry, clear corrupt data, and toggle the panel.
- The full test and build suite passes.

## Task 8: harden CI, package assertions, and the development toolchain

**Priority:** P2  
**Difficulty:** Level 1 for CI and assertions; Level 2 for dependency updates  
**Dependencies:** Task 0  
**Primary files:** `.github/workflows/ci.yml`, `scripts/assert-runtime-build.mjs`, `package.json`, `pnpm-lock.yaml`, optional Dependabot configuration

### Work

1. Set workflow-level default permissions to `contents: read`.
2. Pin every GitHub Action to a full 40-character commit SHA. Keep the release tag in a comment for update readability.
3. Set `persist-credentials: false` on `actions/checkout`.
4. Keep the existing frozen install, check, lint, test, and build steps.
5. Extend `scripts/assert-runtime-build.mjs` to verify:
   - package and generated manifest versions match;
   - popup HTML exists;
   - every popup asset referenced by the generated HTML exists;
   - 16, 32, 48, and 128 pixel icons exist;
   - the service worker and runtime overlay exist;
   - no required host permission or static content script appears;
   - optional hosts and required permissions remain exact;
   - incognito remains disabled.
6. Add tests for the build assertion where practical. At minimum, keep deterministic failures with specific messages.
7. Upgrade WXT and its lockfile to the newest compatible stable release that removes the reported advisories. Do not add overrides that violate package peer ranges.
8. Run the full audit. If advisories remain only in unreachable development tools and no compatible upgrade exists, add a dated, time-bounded exception to the release record. Include advisory IDs, dependency paths, reachability, and an owner. Do not call the audit clean.
9. Remove the redundant direct ESLint parser or plugin dependencies only if `pnpm lint` proves that `typescript-eslint` already supplies the required setup.

### Tests

Run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm audit --prod
pnpm audit || true
```

Also run the repository's GitHub Actions security scanner if available. Confirm that no mutable `uses:` reference remains.

### Acceptance

- GitHub Actions have explicit read-only permissions and immutable action references.
- Checkout does not persist credentials.
- The build assertion rejects incomplete packages and version drift.
- Production audit remains clean.
- Full audit is clean or has an explicit dated exception for development-only, unreachable advisories.

## Task 9: run final automated verification and independent review

**Priority:** Gate  
**Difficulty:** Independent validator  
**Dependencies:** Tasks 1 through 8

### Work

1. Start from a clean worktree.
2. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm lint
   pnpm test
   pnpm build
   pnpm audit --prod
   pnpm audit || true
   git diff --check
   git status --short
   ```

3. Inspect `dist/chrome-mv3/manifest.json` and all package files.
4. Search the production JavaScript for remote URLs, source maps, secrets, `eval`, dynamic script construction, and unexpected network APIs.
5. Have an independent security reviewer trace:
   - URL import request options and byte limits;
   - message sender checks;
   - exact-origin permission and registration checks;
   - SVG and data URL sinks;
   - corruption-tolerant deletion;
   - CI and dependency supply-chain controls.
6. Have an independent maintainability reviewer inspect:
   - canonical parser ownership;
   - panel mutation queue behavior;
   - repository index and migration design;
   - dead popup and page-record removal;
   - remaining duplicate business rules and compatibility aliases.
7. Fix every confirmed blocker or high finding. Repeat this task after fixes.

### Acceptance

- Automated commands pass.
- The production package matches the intended manifest and file list.
- No reviewer reports an unresolved blocker or high finding.
- Any accepted lower-severity finding has an owner and a dated follow-up.
- The worktree is clean.

## Task 10: build the exact release package and run the browser matrix

**Priority:** Gate  
**Difficulty:** Independent validator with browser control, or a human operator  
**Dependencies:** Task 9

### Work

1. Fill in the release record in `docs/release-checklist.md` with:
   - version;
   - candidate commit;
   - build date and operator;
   - Chrome version and platform;
   - second Chromium browser version and platform;
   - rollback owner and approved prior version, or `none` for the first release.
2. Build from the recorded clean commit.
3. Load the exact `dist/chrome-mv3` directory in current Chrome stable and another Chromium browser.
4. Run M01 through M17. Record the observed result for every browser and row.
5. Add URL-import checks for:
   - a same-origin public image;
   - a CORS-allowed cross-origin image;
   - a CORS-blocked image;
   - an oversized declared response;
   - an oversized chunked response;
   - `data:` and current-page `blob:` URLs;
   - HTTP input on an HTTPS page;
   - a URL with query credentials, confirming that diagnostics do not reveal them.
6. Inspect extension storage after clear and permission revocation. Confirm that the origin record, image record, index entry, registration, and overlay are absent.
7. Inspect the browser network panel. Confirm that URL imports send no cookie and no referrer.
8. Create the store archive from the contents of `dist/chrome-mv3`, not from the repository root.
9. Record the archive SHA-256.
10. Upload the archive as a Chrome Web Store draft. Do not submit it yet.
11. Compare the store permission summary and privacy questionnaire with the manifest and Task 1 wording.
12. Record every warning from the upload screen. Resolve warnings that affect permissions, privacy, packaging, or policy.

### Acceptance

- M01 through M17 pass in both browsers or have a resolved defect and a repeated passing run.
- The URL-import additions pass.
- Clear and revocation remove real stored image bytes.
- The archive hash is recorded.
- The store draft shows the expected permission summary.
- Privacy answers match implemented network and storage behavior.
- No unresolved store warning remains.

If browser control or store credentials are unavailable, stop here. Return a handoff that lists this task as the only remaining gate. Do not report the release as ready.

## Task 11: prepare the final handoff and ship decision

**Priority:** Gate  
**Difficulty:** Orchestrator
**Dependencies:** Task 10

### Work

Produce one final report with:

- base and release commit IDs;
- task commits in merge order;
- changed files grouped by task;
- automated command results;
- production audit and full audit results;
- independent review findings and dispositions;
- browser matrix results;
- store archive filename and SHA-256;
- store draft warnings and resolutions;
- residual low and medium risks;
- rollback owner and rollback artifact;
- a final `SHIP` or `NO-SHIP` decision.

Use `SHIP` only when every gate passes. Use `NO-SHIP` when any gate lacks evidence, even if all code tests pass.

## Required regression inventory

Before release, the test suite must prove these behaviors:

- Canonical parsers accept current optional fields and reject unknown keys.
- Popup responses containing `panelPosition` parse successfully.
- Rapid X and Y edits preserve both values.
- Failed panel mutations stop queued work and restore confirmed state.
- URL import rejects oversized declared and chunked responses before buffering them.
- URL fetches omit credentials and referrer information.
- URL diagnostics redact sensitive URL components.
- Button, Enter, paste, drop, and file-picker import paths work.
- Panel destruction removes global listeners.
- Routine snapshot reads do not load unrelated image values.
- V1 index data migrates to V2 once.
- Purge succeeds with corrupt target records and a corrupt index.
- Purge preserves images owned by valid unrelated origins.
- Repeated purge is idempotent.
- Permission revocation uses the corruption-tolerant purge path.
- Build assertions detect missing popup assets, icons, worker, overlay, and version drift.

## Final definition of done

Pixel Pincher is ready for public submission only when all statements below are true:

- Tasks 1 through 9 are merged into a clean release commit.
- No unresolved blocker or high finding remains.
- `pnpm check`, lint, test, build, and production audit pass from a frozen install.
- The full dependency audit is clean or has a documented development-only exception.
- The generated extension has only the intended permissions and files.
- Both browser matrices pass against the exact release build.
- Clear and permission revocation remove actual image bytes, including corrupt-state cases.
- The Chrome Web Store privacy answers disclose user-directed URL requests.
- The upload archive hash and rollback information are recorded.
- The final report says `SHIP` and cites evidence for every release gate.
