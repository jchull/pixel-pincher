# Runtime injection preflight

**Date:** 2026-08-28
**Status:** automated seam and manual proof harness verified; dated manual Chrome results remain required.

## Chosen seam

The proof content entry is `entrypoints/runtime-proof.content.ts`. It uses WXT's
`registration: "runtime"`, `runAt: "document_idle"`, and `allFrames: false`.
It intentionally has no `matches` field, so WXT does not add a static content
script or broad required host permission. Task 3 must register the generated
asset with `chrome.scripting.registerContentScripts` only after the popup has
received an optional permission for one origin.

The proof renderer mounts one Shadow DOM host and uses a visibly patterned data
URL image. It exposes a `data-image-status` of `loaded` or `error` plus visible
status text, so CSP behavior can be observed in Chrome. The DOM test proves
that the host is idempotent and that its image source remains a data URL. It
does **not** prove that a real page's CSP permits that source: Vitest's DOM
does not enforce page CSP. The restrictive fixture at
`tests/fixtures/csp-page.html` deliberately allows only same-origin images, so
it is the required browser test for this uncertainty.

`src/popup/runtime-proof-ui.ts` requests optional permission for the active tab's exact
HTTP(S) origin directly inside its button click handler. It then sends the
origin and tab ID to `entrypoints/background.ts`. The background registers and
injects the proof script only in that tab's top frame. Its registration sets
`persistAcrossSessions: true`.

The WXT runtime entrypoint is explicitly configured with
`registration: "runtime"`. For WXT 0.20, the supported generated
content-script path for `entrypoints/runtime-proof.content.ts` is
`content-scripts/runtime-proof.js`. `pnpm build` runs
`scripts/assert-runtime-proof-build.mjs`, which asserts that asset exists and
that WXT did not emit a static manifest content script or required host
permissions. The path is kept in `RUNTIME_PROOF_SCRIPT_PATH` for both runtime
registration and injection.

## Automated evidence

- `pnpm test` runs JSDOM tests for one Shadow DOM host, its visible image
  load/error state, the direct Chrome permission-request test double, exact
  origin derivation, and registration/message boundaries.
- `pnpm build` asserts that WXT emits the runtime content asset without a
  manifest `content_scripts` entry or broad required `host_permissions`.

## Mandatory manual Chrome checks before Tasks 1–4

1. Run `pnpm build`, load `dist/chrome-mv3` unpacked in Chrome, and serve
   the restrictive CSP fixture over HTTP (for example,
   `python3 -m http.server --directory tests/fixtures 8080`).
2. Open the fixture at `http://localhost:8080/csp-page.html`, open the popup,
   and click **Run runtime proof**. Confirm that the popup reports a direct
   permission request and a successful registration/injection for that exact
   origin.
3. Open a different origin and verify it has not gained site access. Repeat the
   popup action there only if you intend to grant that separate origin.
4. On the fixture, confirm the proof is present only in the top frame and its
   visible status says whether the patterned data URL image loaded or was
   blocked. If it is blocked, replace the proof renderer with a canvas renderer
   before implementing the overlay controller.
5. Reload the fixture, restart Chrome, and return to the same origin. Verify
   that the registration persisted; then use the popup action to inject into
   the already-open active document again.

Record dated results below before Tasks 1 through 4. No manual Chrome result
has been claimed in this commit, so this remains a hard browser gate.
