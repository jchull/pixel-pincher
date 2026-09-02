# Pixel Pincher implementation plan

## Status

This plan is ready for implementation. Complete tasks in dependency order and keep each task in a separate commit unless a task says otherwise.

## Product goal

Pixel Pincher is a browser extension for aligning a reference design with a live web page. A developer uses the in-page control panel to import an image, place it over the page, adjust its transparency and size, optionally invert its colors, and move it by dragging or exact pixel increments.

The first release targets Chromium browsers with Manifest V3. A later release converts the tested Chromium build to a Safari Web Extension.

## First-release scope

The Chromium release includes:

- One reference image per site origin.
- PNG, JPEG, WebP, and SVG import.
- A page overlay that follows document scrolling without changing page layout.
- Transparency from 0% through 100% and independent visibility.
- Proportional resizing from 10% through 600%, a 100% native-size preset, and fit-to-viewport-width sizing.
- Reference-image color inversion.
- Click-through and drag interaction modes.
- Exact X and Y placement in CSS pixels.
- One shared placement per site origin.
- A visibility shortcut and optional nudge commands.
- Automatic restoration after a user grants access to a site.
- Local-only storage. The extension never uploads a reference image.

The Chromium release excludes:

- Image diffing or mismatch highlighting.
- Multiple image layers.
- Side-by-side comparison.
- Image editing, annotations, or rulers.
- Cloud storage, sharing, accounts, or cross-device sync.
- `file://` pages, browser-owned pages, the Chrome Web Store, iframes, and incognito mode.
- Animated GIF. Animation makes stable visual comparison harder and requires a different rendering path.

## Product decisions

### Site access is optional and explicit

The manifest declares `optional_host_permissions` for `http://*/*` and `https://*/*`. It does not declare broad required host access.

When the user imports an image or enables Pixel Pincher on a site, the popup calls `chrome.permissions.request` for that exact origin directly from the click handler. A background message must not stand between the user gesture and the permission request. After the grant, the popup asks the background service worker to register the overlay content script for `<origin>/*` through `chrome.scripting.registerContentScripts`. The registration persists across browser restarts.

If the user denies access, the popup keeps the selected file only long enough to show the denial. It does not store the image. The popup explains that automatic restoration requires site access.

The service worker reconciles saved site records, granted origins, and registered content scripts on install and startup. If the user revokes an origin permission, the service worker unregisters that origin's script and removes its stored image and settings.

### One image belongs to one origin

A reference image, controls, and placement belong to an origin such as `https://example.com`. The image appears at the same location on every HTTP or HTTPS page under that origin.

Clearing a reference removes the origin image and its controls and placement. It preserves no hidden controls or image data.

### Placement uses document coordinates

`placement.x` and `placement.y` are integer CSS pixels from the document's top-left corner. The overlay host is fixed and has no layout effect. The renderer subtracts `window.scrollX` and `window.scrollY` from placement when it paints, so the image follows document scrolling without creating scrollbars.

Scale sizing renders the image proportionally from 10% through 600%. A scale of 100% renders one image pixel per CSS pixel, subject to the browser's device scaling. Fit-width sizing scales the image proportionally until its rendered width equals `window.innerWidth`. Placement remains in unscaled document CSS pixels for either sizing choice. Inversion applies `invert(1)` to the reference image only and does not alter the page.

### Stored images and control state are separate

The image payload is a data URL stored under its own key. Origin metadata and controls never contain the payload. Updating transparency, sizing, inversion, or placement must not read, rewrite, or resend the image.

The extension requests the `unlimitedStorage` permission because users can save references for several origins. Pixel Pincher accepts source images up to 10 MiB, limits the encoded data URL to 14 MiB, and limits each decoded image to 40 million pixels. The import parser checks both limits before replacing the existing reference.

A hydrate message includes the image only when a content script starts or the reference changes. Routine control changes send settings and reference identity without image bytes.

### The extension renders only in the top frame

The content script runs at `document_idle` in the top frame. It never injects into child frames. The Shadow DOM isolates extension styles from page styles. The page must remain fully usable when click-through mode is active.

## Architecture

Use WXT, TypeScript, native DOM APIs, and CSS. Do not add a UI framework for the first release.

| Area | Planned modules | Responsibility |
| --- | --- | --- |
| Domain contracts | `src/shared/contracts.ts`, `src/shared/parse.ts` | Domain types, message unions, validation, and named errors. |
| Persistence | `src/shared/keys.ts`, `src/background/repository.ts` | Storage keys, records, migrations, and image payload isolation. |
| Site access | `src/background/site-access.ts` | Optional permission requests, runtime script registration, and reconciliation. |
| Coordination | `entrypoints/background.ts`, `src/background/coordinator.ts` | Popup requests, content events, commands, navigation, and tab messaging. |
| Page overlay | `entrypoints/overlay.content.ts`, `src/content/overlay-controller.ts` | Shadow DOM, rendering, scrolling, resizing, and dragging. |
| Popup | `entrypoints/popup.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`, `src/popup/popup-controller.ts` | Active-tab access bootstrap, corrupt-data recovery, and in-page panel visibility. |
| Tests | `src/**/*.test.ts`, `tests/fixtures/*` | Contract, repository, controller, popup, and coordinator tests. |

### Dependency rules

- `src/shared` imports no popup, content, background, WXT, or Chrome modules.
- Popup and content code depend on shared contracts, not on each other. Pure image import lives in `src/shared/image-import.ts`.
- Only background repository modules know storage key strings.
- Only the background site-access module knows runtime content-script registration details.
- Only the content controller edits page DOM.
- Chrome and WXT globals stop at entry points or narrow adapters so unit tests can use plain interfaces.

## Domain model

Use branded strings after boundary validation so origins, page keys, and reference IDs cannot be mixed.

```ts
type Origin = string & { readonly __brand: 'Origin' };
type PageKey = string & { readonly __brand: 'PageKey' }; // delivery identity only; never a storage record
type ReferenceId = string & { readonly __brand: 'ReferenceId' };

type Placement = Readonly<{ x: number; y: number }>;
type Sizing =
  | Readonly<{ kind: 'fit-width'; lastScalePercent: number }>
  | Readonly<{ kind: 'scale'; percent: number }>;
type InteractionMode = 'click-through' | 'drag';

type OverlaySettings = Readonly<{
  visible: boolean;
  opacity: number;
  inverted: boolean;
  placement: Placement;
  sizing: Sizing;
  interactionMode: InteractionMode;
}>;

type ReferenceMetadata = Readonly<{
  id: ReferenceId;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  width: number;
  height: number;
  encodedBytes: number;
  importedAt: number;
}>;

type OverlaySnapshot = Readonly<{
  revision: number;
  origin: Origin;
  pageKey: PageKey;
  settings: OverlaySettings;
  reference: ReferenceMetadata | null;
}>;
```

Defaults are visible, 50% opacity, normal colors, placement `{ x: 0, y: 0 }`, fit-width sizing with a remembered 100% manual scale, and click-through interaction.

Clamp opacity to the inclusive range 0 through 1. Scale percent must be an integer from 10 through 600. Placement values must be finite integers within `-1_000_000` through `1_000_000`. Image dimensions must be positive integers, and `width * height` must not exceed 40 million pixels.

`revision` increases after every committed origin mutation. The content controller ignores messages with a revision lower than its current revision. Equal revisions are safe to apply again.

### Persistence records

```ts
type OriginRecordV1 = Readonly<{
  schemaVersion: 1;
  revision: number;
  origin: Origin;
  settings: Omit<OverlaySettings, 'placement'>;
  reference: ReferenceMetadata | null;
}>;

type ImageRecordV1 = Readonly<{
  schemaVersion: 1;
  referenceId: ReferenceId;
  dataUrl: string;
}>;
```

Use these storage keys:

- `pixel-pincher:origin:<encoded-origin>`
- `pixel-pincher:image:<reference-id>`

Encode variable key segments with `encodeURIComponent`. Never scan keys to read one snapshot. Maintain an origin index under `pixel-pincher:origins` for reconciliation and origin cleanup. Cleanup removes any obsolete `pixel-pincher:page:` keys left by unpublished builds without parsing them.

Write a replacement reference in this order:

1. Validate and write the new image record.
2. Write the origin record with the new metadata and incremented revision.
3. Delete the previous image record.

If step 2 fails, delete the new image record and keep the previous origin record. Cleanup on startup removes orphan image records left by interruption. Clearing an origin removes its origin record, image record, index entry, and runtime content-script registration.

Malformed or unknown record versions produce `invalid-stored-data`. Do not silently replace a corrupt record with defaults. The popup must tell the user that clearing the site's data is required.

## Public interfaces

These signatures define module boundaries. An implementation may add private helpers but should not make callers know storage keys, script paths, or Chrome error strings.

```ts
interface OverlayRepository {
  readSnapshot(url: URL): Promise<Result<OverlaySnapshot, RepositoryError>>;
  readHydration(url: URL): Promise<Result<Hydration, RepositoryError>>;
  replaceReference(input: ReplaceReferenceInput): Promise<Result<OverlaySnapshot, RepositoryError>>;
  updateSettings(input: UpdateSettingsInput): Promise<Result<OverlaySnapshot, RepositoryError>>;
  updatePlacement(input: UpdatePlacementInput): Promise<Result<OverlaySnapshot, RepositoryError>>;
  clearOrigin(origin: Origin): Promise<Result<void, RepositoryError>>;
  listOrigins(): Promise<Result<readonly Origin[], RepositoryError>>;
  removeOrphans(): Promise<Result<void, RepositoryError>>;
}

interface SiteAccess {
  has(origin: Origin): Promise<Result<boolean, AccessError>>;
  register(origin: Origin): Promise<Result<void, AccessError>>;
  unregister(origin: Origin): Promise<Result<void, AccessError>>;
  reconcile(origins: readonly Origin[]): Promise<Result<void, AccessError>>;
}

interface TabMessenger {
  sendSettings(tabId: number, snapshot: OverlaySnapshot): Promise<Result<void, DeliveryError>>;
  sendHydration(tabId: number, hydration: Hydration): Promise<Result<void, DeliveryError>>;
  clear(tabId: number, revision: number): Promise<Result<void, DeliveryError>>;
}

interface OverlayController {
  hydrate(hydration: Hydration): Promise<Result<void, RenderError>>;
  apply(snapshot: OverlaySnapshot): void;
  clear(revision: number): void;
  destroy(): void;
}
```

`Result<T, E>` is a discriminated union with `ok: true` and `value`, or `ok: false` and `error`. Do not throw expected permission, validation, storage, delivery, or rendering failures across these interfaces.

## Messaging contract

Chrome messages are untrusted `unknown` values. Parse each message at the receiving entry point.

```ts
type PopupRequest =
  | { kind: 'get-tab-state'; requestId: string }
  | { kind: 'register-site'; requestId: string; url: string }
  | { kind: 'replace-reference'; requestId: string; url: string; reference: ImportedReference }
  | { kind: 'update-settings'; requestId: string; url: string; patch: SettingsPatch }
  | { kind: 'clear-site'; requestId: string; url: string };

type ContentRequest =
  | { kind: 'hydrate-overlay'; hydration: Hydration }
  | { kind: 'apply-settings'; snapshot: OverlaySnapshot }
  | { kind: 'clear-overlay'; revision: number };

type ContentEvent =
  | { kind: 'content-ready'; url: string }
  | { kind: 'placement-committed'; url: string; placement: Placement }
  | { kind: 'image-load-failed'; url: string; referenceId: ReferenceId };

type PopupResponse<T> =
  | { requestId: string; ok: true; value: T }
  | { requestId: string; ok: false; error: PublicError };
```

`Hydration` contains an `OverlaySnapshot` and the current image data URL when a reference exists. `OverlaySnapshot` contains metadata but no image payload.

`SettingsPatch` is a discriminated union, not `Partial<OverlaySettings>`. Each variant changes one setting: visibility, opacity, inversion, sizing, interaction mode, or placement. The parser rejects extra or malformed fields.

Every response repeats `requestId`. Every public error has a stable code and a user-safe message. Required error codes are:

- `unsupported-url`
- `site-access-denied`
- `site-access-revoked`
- `content-unavailable`
- `invalid-image-type`
- `image-too-large`
- `image-too-many-pixels`
- `image-decode-failed`
- `invalid-request`
- `invalid-stored-data`
- `storage-failed`
- `image-render-failed`

Do not expose raw Chrome error strings in popup text. Log the raw cause in development builds when it helps diagnosis.

## Runtime flows

### Open the popup

1. The popup queries the active tab.
2. It rejects missing URLs and schemes other than HTTP or HTTPS.
3. It derives the origin and checks optional permission state.
4. Without access, it renders the no-access state and an **Enable on this site** action.
5. With access, it confirms the enabled state and offers the in-page panel toggle. Reference data and overlay controls remain in the page.

### Enable a site

1. The popup handles a user click and calls `chrome.permissions.request` for `<origin>/*` before the click handler returns.
2. After permission succeeds, it sends `register-site` so the background registers the runtime content script for that origin.
3. The background injects the script into the active tab once if registration did not cover the current document.
4. The script sends `content-ready` with `location.href`.
5. The background reads hydration for that URL and sends it to the tab.

### Import a reference

1. The in-page control panel checks file size and accepted MIME type.
2. Its shared importer decodes the image and checks dimensions and pixel count.
3. It accepts source files up to 10 MiB, creates a data URL, and checks the encoded 14 MiB limit.
4. The sender-bound panel request replaces the reference only after site access is granted.
5. The repository commits the replacement in the documented order and the background sends one hydration message.

A failed import leaves the current stored and displayed reference unchanged.

### Update controls

1. The in-page control panel sends one validated sender-bound `SettingsPatch`.
2. The repository commits the control or placement change and increments revision.
3. The background sends `apply-settings` without image bytes.
4. The content controller applies the snapshot idempotently.

Opacity updates may be sent while the range control moves, but the panel allows only one request in flight and coalesces queued values to the latest value. Do not use a timer that can apply stale values after the final change.

### Navigate or reload

A persisted runtime content script starts on full document loads and sends `content-ready`. The background uses the event's URL, not a cached tab URL.

The background listens to `chrome.webNavigation.onHistoryStateUpdated` for top-frame single-page application navigation. It reads the new page snapshot and sends `apply-settings` when the reference identity is unchanged. It sends hydration if identity changed. `popstate` and hash-only changes do not require a new page key, but scroll and rendering still update normally.

### Revoke access

The background listens to `chrome.permissions.onRemoved`. For each removed origin, it unregisters the content script, clears open overlays on that origin when possible, and deletes stored site data. Reconciliation repeats this cleanup on startup in case the service worker was stopped during revocation.

## Overlay controller behavior

The controller creates one custom host element with a Shadow DOM and an image element. The host uses a z-index of `2147483647`, `position: fixed`, zero layout dimensions, and `pointer-events: none` by default.

Task 0 proved on 2026-08-28 (see `docs/decisions/runtime-injection.md`) that an image data URL created by the extension renders inside the Shadow DOM on a page with restrictive `img-src 'self'`. The image renderer is the chosen path. Keep the `createImageBitmap` canvas fallback documented here only as the response to a future CSP change that blocks data URLs.

Rendering rules:

- Compute screen X as `placement.x - window.scrollX`.
- Compute screen Y as `placement.y - window.scrollY`.
- Apply position with `transform: translate3d(...)`.
- In scale sizing, set image width to `intrinsicWidth * percent / 100` CSS pixels and height to `auto`.
- In fit-width sizing, set image width to `window.innerWidth` and height to `auto`.
- Apply `filter: invert(1)` only when inversion is enabled. Inversion must compose with opacity without changing layout or stored image bytes.
- Hide the host when visibility is false or no reference exists.
- Keep decoded image state while hidden.
- Repaint at most once per animation frame during scroll, resize, or drag.
- Revoke object URLs and remove listeners in `destroy()`.

Drag rules:

- Drag mode enables pointer events only on the image.
- Pointer down captures the pointer and records document-space placement.
- Pointer move previews placement locally without storage writes.
- Pointer up or cancel rounds to integer CSS pixels and emits one `placement-committed` event.
- Escape during a drag restores the starting placement and emits no event.
- The controller prevents native image dragging and text selection only for the overlay image.

`hydrate`, `apply`, `clear`, and `destroy` are idempotent. The controller never creates a second host.

## Popup responsibilities

The popup has loading, unsupported-page, access-required, enabled, and error presentations. It performs only these operations:

- Load active-tab state.
- Request exact-origin permission directly from a user gesture.
- Register or repair the runtime content script after a grant.
- Retry a failed state load or registration.
- Clear corrupt site data.
- Show or hide the in-page control panel.

The in-page panel owns image import, reference replacement, overlay settings, placement, and ordinary site clearing. The popup width remains at most 360 CSS pixels, every popup action has a visible label, and status uses a polite live region.

## Task 0 proven details

Recorded 2026-08-28 after manual Chrome verification; the full dated results are in `docs/decisions/runtime-injection.md`. The proof-only code was deleted in the Task 0 completion commit. These details bind Tasks 3 and 6.

- **Content entry:** a WXT content entrypoint with `registration: "runtime"` and no static `matches` field. WXT 0.20 emits it at `content-scripts/<entry-name>.js` and adds no manifest `content_scripts` entry or required host permissions.
- **Registration:** after the popup's direct permission grant, the background can register the generated asset for the exact match `<origin>/*` with `allFrames: false`, `runAt: "document_idle"`, and `persistAcrossSessions: true`. Registration persists across a browser restart, and `chrome.scripting.executeScript` injects it into an already-open tab after a grant. Task 3 uses one deterministic registration ID per origin.
- **Renderer:** an `img` element with a data URL source inside the Shadow DOM renders under the restrictive `img-src 'self'` CSP fixture. Task 6 uses the image renderer; the canvas fallback is not required.

## Definition of done for every task

A task is complete only when:

- Its acceptance criteria pass.
- New public boundaries have unit tests.
- `pnpm check`, `pnpm lint`, `pnpm test`, and `pnpm build` pass.
- Manual checks listed by the task pass in unpacked Chrome.
- The commit contains no unrelated formatting or generated output.
- The implementation updates this plan if a proven browser constraint changes a design decision.

Sizes use focused engineering time: **S** is up to half a day, **M** is about one day, **L** is about two days, and **XL** is three or more days. Difficulty measures uncertainty and integration risk, not elapsed time.

## Task breakdown

### Task 0: Lock tooling and prove browser assumptions

- **Difficulty:** High
- **Size:** M
- **Depends on:** Repository initialization
- **Files:** `package.json`, `pnpm-workspace.yaml`, `vitest.config.ts`, `.github/workflows/ci.yml`, `tests/fixtures/csp-page.html`, temporary proof entry points as needed

Add `packageManager`, supported Node engines, a DOM test environment, Chrome API test doubles, and CI. Make `pnpm test` fail when no tests exist after the first real test lands. CI runs install with the frozen lockfile, type-check, lint, tests, and build.

Build a temporary or test-only runtime content script with WXT `registration: 'runtime'`. Prove all of these in unpacked Chrome:

- Calling `chrome.permissions.request` directly in the popup click handler succeeds, while routing the request through the background is not required.
- Requesting one exact origin does not grant access to unrelated origins.
- Registration persists across a reload and browser restart.
- The script runs only in the top frame.
- The background can inject it into the already-open active document after permission grant.
- Shadow DOM image rendering works on the restrictive CSP fixture, or canvas rendering works as the documented fallback.
- WXT emits stable content-script asset paths that `site-access.ts` can register.

Record the chosen registration and renderer details in this plan, then delete proof-only code. Do not start Tasks 1 through 4 until these checks pass.

**Acceptance:** CI passes from a clean clone, and the five browser checks have dated notes in the commit or `docs/decisions/runtime-injection.md`.

### Task 1: Implement contracts, parsers, and key derivation

- **Difficulty:** Medium
- **Size:** M
- **Depends on:** Task 0
- **Files:** `src/shared/contracts.ts`, `src/shared/parse.ts`, `src/shared/keys.ts`, related tests

Implement the domain types, `Result`, message unions, record parsers, URL parsing, key constructors, default settings, limits, and public error mapping. Treat messages and stored values as `unknown`. Do not use `any` or unchecked casts.

Test valid and invalid message variants, extra fields, URL schemes, origin and page key derivation, hash removal, opacity and scale bounds, sizing variants, inversion, image metadata bounds, record versions, and every public error code.

**Acceptance:** Background, popup, and content code can use parsed domain values without knowing raw message or storage shapes.

### Task 2: Implement the repository and migrations

- **Difficulty:** High
- **Size:** L
- **Depends on:** Task 1
- **Files:** `src/background/repository.ts`, `src/background/storage-adapter.ts`, related tests

Implement `OverlayRepository` over a narrow storage adapter. Keep origin and image records separate. Implement replacement rollback, origin cleanup, revision increments, origin indexing, and orphan cleanup. No method that updates settings may fetch or write image data.

Test fresh state, site-scoped placement, reference replacement success and rollback, interrupted replacement cleanup, clear-origin cleanup, malformed data, unknown schema versions, storage failures, and monotonic revisions.

**Acceptance:** Repository tests inspect adapter calls and prove that transparency, sizing, inversion, and placement updates never touch image keys.

### Task 3: Implement optional site access and runtime registration

- **Difficulty:** High
- **Size:** L
- **Depends on:** Tasks 0 through 2
- **Files:** `wxt.config.ts`, `src/background/site-access.ts`, runtime content-script entry configuration, related tests

Declare only `activeTab`, `storage`, `unlimitedStorage`, `scripting`, `webNavigation`, and optional HTTP and HTTPS origins. Set manifest incognito behavior to `not_allowed`. Keep the permission request in the popup. Implement permission checks, registration, active-tab injection, unregister, startup reconciliation, and permission-removal cleanup in the background.

Configure the WXT content entry with `registration: 'runtime'` and no broad static match. Use one deterministic registration ID per origin and register the exact match only after permission grant. Registration uses `allFrames: false`, `runAt: 'document_idle'`, and persistent MV3 registration. On startup and extension update, replace stale registrations so they reference the current packaged asset. Treat duplicate registration and missing registration as idempotent success after verifying final state.

Test denial, grant, duplicate registration, revoked permission, stale registration, stored origin without permission, permission without stored origin, restricted URLs, and Chrome API errors.

**Acceptance:** An origin restores after reload, another origin remains inaccessible, and revoking permission removes registration and stored site data.

### Task 4: Implement background coordination and typed delivery

- **Difficulty:** High
- **Size:** L
- **Depends on:** Tasks 1 through 3
- **Files:** `entrypoints/background.ts`, `src/background/coordinator.ts`, `src/background/tab-messenger.ts`, related tests

Implement popup request handling, content event handling, active-tab resolution, typed responses, hydration delivery, settings-only delivery, and startup work. Resolve the target URL for popup actions once, validate that it matches the request origin, and reject tab changes during a request.

Content delivery retries once only for a missing receiver after verified permission and injection. Other errors return immediately. Store the latest `image-render-failed` status by tab ID in memory so the next popup open can report it. Treat that status as diagnostic only because service-worker memory can disappear.

Test every request and event, tab closure during a request, active-tab change, stale revision delivery, missing receiver retry, render failure, repository failure, and response correlation by `requestId`.

**Acceptance:** Routine settings changes send no image payload, while startup and reference replacement send exactly one hydration payload.

### Task 5: Implement image import

- **Difficulty:** Medium
- **Size:** M
- **Depends on:** Tasks 1 and 4
- **Files:** `src/shared/image-import.ts`, fixtures for supported and rejected files, related tests

Parse PNG, JPEG, WebP, and SVG files. Check file type, decode success, intrinsic dimensions, pixel count, data URL type, and encoded size. Generate a cryptographically random reference ID. Never insert SVG markup into popup or page HTML.

Keep file reading and image decoding behind injected functions so unit tests can use fixtures without browser timing. A failed import must not send `replace-reference`.

Test every accepted type, a MIME mismatch, unknown type, zero dimensions, decode failure, encoded-size overflow, pixel-count overflow, and SVG with script content rendered only as an image source.

**Acceptance:** Replacing a valid image updates the current overlay, and every rejected file leaves the previous reference intact.

### Task 6: Implement the overlay controller

- **Difficulty:** High
- **Size:** L
- **Depends on:** Tasks 0, 1, and 4
- **Files:** `entrypoints/overlay.content.ts`, `src/content/overlay-controller.ts`, `src/content/overlay.css`, related tests

Implement content startup, Shadow DOM creation, hydration, settings-only updates, revision handling, scroll and viewport-resize painting, visibility, fit-width and proportional sizing, transparency, inversion, both interaction modes, drag commit, Escape cancellation, clear, and destroy.

Use the renderer proven in Task 0. Do not let the host affect page layout or scrolling. Announce `content-ready` with `location.href`. Report image decode or render failure with reference identity.

Test duplicate startup, old and equal revisions, scroll math, viewport resize, 10%, 100%, and 600% sizing, fit-width transitions, transparency endpoints, inversion on and off, hiding without image loss, image replacement, clear, listener cleanup, drag commit, drag cancellation, and pointer capture loss.

**Acceptance:** The overlay aligns to document coordinates while scrolling and remains isolated on the CSP fixture and a page with aggressive global CSS.

### Task 7: Build the popup access bootstrap

- **Difficulty:** Medium
- **Size:** L
- **Depends on:** Tasks 4 and 5
- **Files:** `entrypoints/popup.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`, `src/popup/popup-controller.ts`, related tests

Keep the popup as an access and recovery surface. Its state machine loads the active tab, requests exact-origin permission directly from the enable action, registers the runtime script, retries failures, clears corrupt data, and toggles the in-page panel. Keep Chrome tab queries, the direct permission request, and runtime messages behind an adapter.

The in-page panel owns imports, settings, placement, and ordinary clearing through sender-bound content requests. The popup does not parse files or dispatch reference or settings mutations.

**Acceptance:** The generated popup opens and a keyboard-only user can enable a site, retry an error, clear corrupt data, and show or hide the in-page panel without reloading.

### Task 8: Add commands, SPA navigation, and recovery

- **Difficulty:** High
- **Size:** M
- **Depends on:** Tasks 4, 6, and 7
- **Files:** `wxt.config.ts`, `src/background/commands.ts`, `src/background/navigation.ts`, related tests

Declare toggle visibility plus nudge-left, nudge-right, nudge-up, and nudge-down commands. Give only visibility a default suggested shortcut. Leave nudge commands unbound so users can assign non-conflicting shortcuts in browser settings.

Handle top-frame `webNavigation.onHistoryStateUpdated`. Read state from the event URL and deliver settings or hydration as required. Commands use the active tab's current URL, require existing permission and a reference, persist changes, and deliver the new revision. Restricted pages and missing references are no-ops.

On full reload, content startup restores state. On service-worker restart, repository state and persisted script registrations remain authoritative. Startup reconciliation repairs registrations and orphan records.

Test command directions, origin-scoped placement updates, SPA route changes, query-string changes, hash-only changes, service-worker restart, content restart, and navigation races.

**Acceptance:** Reload, back and forward navigation, `history.pushState`, and a service-worker restart preserve the correct origin image and site-scoped placement.

### Task 9: Finish accessibility, visual design, and extension assets

- **Difficulty:** Medium
- **Size:** M
- **Depends on:** Task 7
- **Files:** popup CSS and HTML, `public/icon/*`, `README.md`

Finish popup spacing, typography, focus styles, contrast, loading states, and error text. Add production icons at all manifest-required sizes. Add reduced-motion behavior if any transition remains. The overlay has no visible chrome in click-through mode and only a subtle focus or drag outline in drag mode.

Test popup zoom at 80%, 100%, and 200%. Test keyboard order and screen-reader names. Verify high-contrast mode where Chrome supports it. Confirm that extension icons remain legible at 16 and 32 pixels.

**Acceptance:** Accessibility checks find no unlabeled controls, clipped content, hidden focus, or contrast failures in the supported popup states.

### Task 10: Complete Chromium release verification

- **Difficulty:** Medium
- **Size:** M
- **Depends on:** Tasks 0 through 9
- **Files:** `README.md`, `docs/release-checklist.md`, test fixtures, CI configuration as needed

Document setup, unpacked installation, site-access behavior, shortcuts, local storage, data limits, troubleshooting, and known exclusions. Add the release checklist for versioning, production build, permissions review, icons, screenshots, privacy disclosure, Chrome Web Store package, and rollback.

Run the release matrix on current stable Chrome and one other Chromium browser:

- Import each supported image type.
- Reject every documented invalid image class.
- Exercise visibility, 0%, 50%, and 100% transparency, 10%, 100%, and 600% scale, fit width, inversion, interaction modes, drag, exact inputs, and commands.
- Scroll and resize at several browser zoom levels.
- Reload and restart the browser.
- Navigate a multi-route SPA, including query and hash changes.
- Revoke and regrant site access.
- Test restrictive CSP and aggressive page CSS fixtures.
- Open unsupported and browser-owned pages.
- Clear the site and confirm that its storage and registration are gone.

**Acceptance:** CI is green, the production build loads without warnings, and every release-matrix row has a recorded result.

### Task 11: Port the accepted build to Safari

- **Difficulty:** High
- **Size:** XL
- **Depends on:** Task 10 and an accepted Chromium release candidate
- **Files:** `docs/safari-port.md`, generated Xcode project, browser adapters only when required

Run Apple's Safari Web Extension Converter against the production build. Record converter warnings, Xcode and signing steps, Safari permission behavior, storage limits, runtime registration support, keyboard command differences, and App Store packaging requirements.

If Safari lacks a required API, add one narrow adapter behind `OverlayRepository`, `SiteAccess`, or `TabMessenger`. Do not add browser checks throughout popup or content code. Re-run the Chromium release matrix after any shared-code change.

**Acceptance:** The Safari build passes the same functional matrix or `docs/safari-port.md` records a reviewed, explicit difference.

## Delivery sequence

Implement Tasks 0 through 4 in order. Task 0 is a hard gate because runtime registration and page CSP determine the viable architecture. After Task 4, Tasks 5 and 6 can proceed independently. Task 7 follows Task 5 and Task 4. Task 8 joins coordinator, content, and popup behavior. Tasks 9 and 10 are release gates. Task 11 starts only after Chromium acceptance.

The expected Chromium work is about 13 to 16 focused engineering days, including browser verification. Safari work is separate and may change after the converter reports platform differences.
