# Pixel Pincher implementation plan

## Product boundary

Pixel Pincher lets a developer place a design image over the current page, then adjust the image until the page and the design line up. The first release targets Chromium browsers through Manifest V3. The extension stores settings locally and never uploads an image.

The first release includes:

- Importing PNG, JPEG, WebP, GIF, or SVG reference images from the popup.
- Showing one image overlay in the active tab.
- Opacity, visibility, pointer-event mode, drag placement, and one-pixel keyboard nudges.
- Fit-to-viewport and native-size display modes.
- Per-origin and per-page settings that survive browser restarts.
- Keyboard shortcuts for visibility and nudge operations.
- A compact popup that works without a page reload.

The first release does not include image diffing, side-by-side comparison, multi-image layers, sharing, cloud storage, cross-device sync, or editing images. Those features would turn a focused overlay tool into a different product.

Safari does not run Chrome extensions directly. After Chromium support is stable, convert the MV3 build with Apple's Safari Web Extension Converter, then replace or document APIs that differ. Keep browser-specific code behind a small adapter so that port stays bounded.

## Technical shape

Use WXT and TypeScript. WXT owns the Manifest V3 build, the popup entry point, the content-script bundle, and extension messaging.

| Area | Files to add | Responsibility |
| --- | --- | --- |
| Shared contracts | `src/shared/contracts.ts`, `src/shared/storage.ts` | Typed messages, persisted settings, storage keys, and validation. |
| Popup | `entrypoints/popup.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css` | Import image, edit controls, and show active-tab state. |
| Content script | `entrypoints/overlay.content.ts`, `src/content/overlay-controller.ts`, `src/content/overlay.css` | Create and update an isolated overlay in the web page. |
| Background service worker | `entrypoints/background.ts` | Route requests that need `chrome.storage`, image persistence, or active-tab coordination. |
| Tests | `src/**/*.test.ts` | Unit-test parsing, state updates, and message validation. |

Use native DOM and CSS for the first release. A component framework adds build weight but does not solve a problem in this small UI.

### Runtime flow

1. The popup asks the service worker for the active tab's current state.
2. On import, the popup decodes and validates the file before it sends a data URL and image metadata to the service worker.
3. The service worker saves the image and settings, then sends an `apply-overlay` message to the content script in the active tab.
4. The content script creates one fixed-position host element with a Shadow DOM. It applies all changes locally and sends state changes caused by dragging back to the service worker.
5. When the page reloads, the content script asks for the saved state and recreates the overlay.

The content script owns DOM state. The service worker owns durable state. The popup never edits page DOM.

### Persisted model

```ts
type Placement = { x: number; y: number };

type OverlayMode = 'fit-viewport' | 'native-size';

type OverlaySettings = {
  version: 1;
  visible: boolean;
  opacity: number;
  placement: Placement;
  mode: OverlayMode;
  pointerEvents: 'none' | 'auto';
};

type StoredReference = {
  imageDataUrl: string;
  imageName: string;
  width: number;
  height: number;
  importedAt: number;
};

type PageOverlayState = OverlaySettings & {
  reference?: StoredReference;
};
```

Store the reference and settings under `pixel-pincher:origin:<origin>`. Store a separate page override under `pixel-pincher:page:<origin><pathname><search>` only when the user changes placement. Read the page override first, then merge it over origin settings. Do not include hashes in page keys because in-page navigation should keep the same alignment.

Clamp `opacity` to 0 through 1. Store placement in CSS pixels as finite integers. Reject image data URLs above 8 MiB before storage. `chrome.storage.local` is the source of truth, so the extension still works after the service worker stops.

### Overlay behavior

The host is `position: fixed`, starts at viewport origin, has a high z-index, and has no layout effect on the page. Use a Shadow DOM to prevent page styles from changing the controls or image. The image is selectable only when pointer-event mode is `auto`. In that mode, dragging changes `placement`; otherwise, the host has `pointer-events: none` and the page remains usable.

Fit-to-viewport preserves aspect ratio and scales the image so its width equals `window.innerWidth`. Native size uses the image's intrinsic dimensions. Placement applies after scaling. On resize, fit mode recalculates scale without changing the stored placement.

The controller must remove its host on `clear-overlay`, avoid creating duplicate hosts, and clean up all event listeners when the document unloads. It must not inject scripts into `chrome://`, extension, or other restricted pages. The popup must show a clear error for those tabs.

### Messaging

Use a discriminated `kind` field for every message. Validate values at the receiving boundary before the message changes state.

```ts
type PopupRequest =
  | { kind: 'get-state' }
  | { kind: 'import-reference'; reference: StoredReference }
  | { kind: 'update-settings'; patch: Partial<OverlaySettings> }
  | { kind: 'clear-reference' };

type ContentRequest =
  | { kind: 'hydrate-overlay'; state: PageOverlayState }
  | { kind: 'apply-overlay'; state: PageOverlayState }
  | { kind: 'clear-overlay' };

type ContentEvent =
  | { kind: 'drag-committed'; placement: Placement }
  | { kind: 'content-ready' };
```

Prefer full `PageOverlayState` messages to a chain of patches between the service worker and the content script. A full state makes reload recovery and message retries idempotent.

## Task breakdown

### 1. Add shared contracts and storage helpers

- **Difficulty:** Medium
- **Size:** M, about 1 day
- **Depends on:** Repository initialization
- **Files:** `src/shared/contracts.ts`, `src/shared/storage.ts`, `src/shared/contracts.test.ts`, `src/shared/storage.test.ts`

Define the persisted types, message unions, key constructors, default settings, and runtime parsers described above. Parse all external data from `chrome.storage` and extension messages as `unknown`. Return a typed result or a named error. Do not use unchecked casts.

`readPageState(url)` must derive origin and page keys, merge origin settings with the page placement override, and return defaults when no record exists. `writeOriginState` must write a complete origin record. `writePagePlacement` must write only a placement override. `clearReference` must delete the image while preserving controls so a later import retains the user's preferred opacity and mode.

Test key derivation, default state, page override precedence, malformed stored values, image size rejection, and settings clamping. A later task must be able to call these helpers without knowing storage key formats.

### 2. Add the background service worker and tab coordinator

- **Difficulty:** Medium
- **Size:** M, about 1 day
- **Depends on:** Task 1
- **Files:** `entrypoints/background.ts`, `src/background/tab-coordinator.ts`, `src/background/tab-coordinator.test.ts`

Add the WXT background entry point. It listens for popup requests and content events. It resolves the sender or active tab, reads or writes state through Task 1, and sends the resulting complete state to that tab's content script.

When a popup request targets a tab without a ready content script, attempt `chrome.scripting.executeScript` only on allowed HTTP and HTTPS tabs. Then retry the message once. Return a typed `restricted-tab` error for browser pages, the Chrome Web Store, and missing tab URLs. Do not request broad host permissions. `activeTab` grants access after the user opens the popup.

Keep a small in-memory set of ready tab IDs only as an optimization. Correctness must come from storage and a content-script retry, because service workers stop at any time. Test the coordinator with mocked Chrome APIs for success, restricted pages, content-not-ready retry, and storage errors.

### 3. Build the overlay controller in an isolated page host

- **Difficulty:** High
- **Size:** L, about 2 days
- **Depends on:** Task 1
- **Files:** `entrypoints/overlay.content.ts`, `src/content/overlay-controller.ts`, `src/content/overlay.css`, `src/content/overlay-controller.test.ts`

Create a content entry point that announces `content-ready`, asks the service worker for state, and gives all `ContentRequest` messages to `OverlayController`. The controller creates exactly one `pixel-pincher-host` element, attaches an open Shadow DOM, and renders an `<img>` inside it.

`apply(state)` must be idempotent. If no reference exists or `visible` is false, hide the host without deleting the current image. Apply opacity, mode, placement, and pointer-event mode with CSS custom properties or direct styles. `clear()` must remove the host and reset controller memory.

Implement drag only when pointer-event mode is `auto`. On pointer down, record the cursor and starting placement. On pointer move, update the displayed position with `requestAnimationFrame`. On pointer up or cancel, round the position to CSS pixels and send one `drag-committed` event. Use pointer capture so a drag remains stable when the cursor leaves the image. Do not write storage during pointer moves.

Use unit tests with a DOM environment for duplicate-host prevention, applying state, clearing state, and drag commit. Manually test on pages with aggressive global CSS and a fixed navigation bar.

### 4. Add image import and validation

- **Difficulty:** Medium
- **Size:** M, about 1 day
- **Depends on:** Tasks 1 and 2
- **Files:** `src/popup/import-reference.ts`, `src/popup/import-reference.test.ts`

Implement a file parser that accepts PNG, JPEG, WebP, GIF, and SVG files by MIME type and file signature where practical. Reject unknown types, files larger than 8 MiB, decode failures, and images with zero dimensions. Load the selected image in a browser `Image` object to record intrinsic width and height, then emit a `StoredReference` with a data URL and timestamp.

SVG files can contain active content. Load them only as an image data URL, never insert SVG markup into the page. Document that Chrome applies its normal image isolation rules, and reject SVGs whose decoding fails. Keep the parser independent of popup DOM so tests can use file fixtures.

Show errors next to the file control and keep the current overlay unchanged after a failed import. A successful import sends `import-reference` to Task 2 and immediately reflects in the current tab.

### 5. Build the popup controls

- **Difficulty:** Medium
- **Size:** L, about 2 days
- **Depends on:** Tasks 2 and 4
- **Files:** `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`, `src/popup/popup-controller.ts`, `src/popup/popup-controller.test.ts`

Replace the placeholder popup with a narrow, keyboard-accessible control panel. It has a file input, image name and dimensions, a visibility toggle, opacity range input with percentage text, mode radio group, pointer-event mode toggle, X and Y numeric inputs, a clear-reference button, and a status area.

On open, request `get-state` and render the returned state. On each committed control change, send one `update-settings` request. Use `input` for opacity so the page responds as the slider moves, but persist only after a short 150 ms debounce or the final `change` event. Number inputs accept signed integers and commit on blur or Enter. Disable reference-specific controls when no image is stored.

Every control needs a visible label. The status area uses `aria-live="polite"`. Errors must remain visible until the user makes another request. The popup must not use a framework-specific state store. Keep a small render function that receives complete `PageOverlayState`.

### 6. Add keyboard commands and page-local nudging

- **Difficulty:** Medium
- **Size:** M, about 1 day
- **Depends on:** Tasks 2, 3, and 5
- **Files:** `wxt.config.ts`, `entrypoints/background.ts`, `src/background/commands.ts`, `src/background/commands.test.ts`

Declare commands for toggle visibility, nudge left, nudge right, nudge up, and nudge down. Give toggle visibility a default shortcut such as `Alt+Shift+O`. Leave arrow commands unbound by default because browser and operating-system shortcuts conflict. The extension's shortcut settings page remains the place where users bind them.

On a nudge command, read the active tab's state, add or subtract one CSS pixel, persist a page placement override, and send the complete new state to the content script. If the user holds Shift in popup number controls, use a 10-pixel step there. Chrome commands do not provide modifier details consistently, so do not promise shifted keyboard shortcuts inside page content.

Commands are no-ops when the active tab has no reference or is restricted. Test movement directions and page-override creation.

### 7. Handle navigation, resize, and failure recovery

- **Difficulty:** High
- **Size:** M, about 1.5 days
- **Depends on:** Tasks 2, 3, 5, and 6
- **Files:** `src/content/overlay-controller.ts`, `src/background/tab-coordinator.ts`, `src/shared/storage.ts`, related tests

Make hydration reliable across popup opens, page reloads, single-page application route changes, browser restarts, and service-worker restarts. The content script must request state on every document load. For client-side route changes, use the current URL when the content script sends `content-ready`; the service worker must recompute page overrides from that URL instead of using a stale tab URL.

Listen for viewport resize. Fit mode must recompute the image width on the next animation frame. Native size must not change. Preserve stored placement in both modes. If a reference cannot load in the page, hide the host and report `overlay-image-load-failed` to the popup through the service worker. Do not delete the stored reference automatically.

Add a manual recovery checklist to the README: reload the page, open the popup, and clear/reimport only after the popup reports an image load error.

### 8. Add visual polish and accessibility checks

- **Difficulty:** Low
- **Size:** S, about half a day
- **Depends on:** Task 5
- **Files:** `entrypoints/popup/style.css`, `src/content/overlay.css`, `README.md`

Set popup layout, focus styles, color contrast, and touch targets. The overlay itself must have no visible chrome in pointer-events-none mode. In pointer-events-auto mode, show a subtle outline only while the image has keyboard focus or is being dragged. The outline must not become part of the comparison image.

Test the popup at browser zoom levels of 80%, 100%, and 200%. Navigate all controls with a keyboard and verify that screen-reader labels identify the current value and action. Keep the popup under roughly 360 CSS pixels wide so it remains readable in Chrome's extension menu.

### 9. Add automated checks and release documentation

- **Difficulty:** Medium
- **Size:** M, about 1 day
- **Depends on:** Tasks 1 through 8
- **Files:** `vitest.config.ts`, test fixtures, `.github/workflows/ci.yml`, `README.md`, `docs/release-checklist.md`

Configure Vitest with a DOM environment for controller tests. Add a CI workflow that runs `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint`, `pnpm test`, and `pnpm build`. Use the committed lockfile and Node 24 unless the project later standardizes on another supported Node version.

Write a release checklist that covers manifest version increment, production build, unpacked Chrome smoke test, permissions review, icons, screenshots, and the Safari conversion check. Do not publish automatically in the first release.

The final smoke test must import each supported image type, test opacity and both display modes, drag and nudge the image, reload the page, test an SPA route change, clear the image, and open a restricted Chrome page to confirm the error message.

### 10. Port to Safari after Chromium acceptance

- **Difficulty:** High
- **Size:** L, about 2 to 3 days
- **Depends on:** Task 9 and an accepted Chromium release candidate
- **Files:** `docs/safari-port.md`, browser adapter files only if required by converter output

Run Apple's Safari Web Extension Converter against the production Chromium build. Record the Xcode project, signing configuration, required Safari permissions, and every converter warning in `docs/safari-port.md`. Test image import, storage, popup communication, page overlay injection, keyboard commands, and restricted-page behavior in Safari.

If Safari lacks an API or behaves differently, add a narrow adapter behind the shared contracts. Do not scatter browser checks through popup or overlay code. Treat Safari compatibility as a separate release gate, not as a reason to delay the Chromium first release.

## Delivery order

Complete Tasks 1 through 3 before building popup UI. They establish the state and DOM boundaries that every later feature uses. Complete Tasks 4 and 5 next, then Tasks 6 and 7. Tasks 8 and 9 are release gates. Task 10 begins only after the Chrome version passes the full smoke test.

Each task ends with focused tests and a manual check. Keep commits task-scoped. Do not combine the Safari work with Chromium feature work.
