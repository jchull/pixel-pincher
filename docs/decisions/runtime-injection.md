# Runtime injection preflight

**Date:** 2026-08-28
**Status:** automated seam verified; manual Chrome gate remains required.

## Chosen seam

The proof content entry is `entrypoints/runtime-proof.content.ts`. It uses WXT's
`registration: "runtime"`, `runAt: "document_idle"`, and `allFrames: false`.
It intentionally has no `matches` field, so WXT does not add a static content
script or broad required host permission. Task 3 must register the generated
asset with `chrome.scripting.registerContentScripts` only after the popup has
received an optional permission for one origin.

The proof renderer mounts one Shadow DOM host and uses a data URL image. The
DOM test proves that the host is idempotent and that its image source remains a
data URL. It does **not** prove that a real page's CSP permits that source:
Vitest's DOM does not enforce page CSP. The restrictive fixture at
`tests/fixtures/csp-page.html` deliberately allows only same-origin images, so
it is the required browser test for this uncertainty.

## Automated evidence

- `pnpm test` runs a JSDOM test for one Shadow DOM host, its data URL image,
  and the Chrome permission-request test double.
- `pnpm build` must be inspected to confirm WXT emits the runtime content
  asset without a manifest `content_scripts` entry or broad `host_permissions`.

## Mandatory manual Chrome checks before Tasks 1–4

1. Load the unpacked production build in Chrome and open the restrictive CSP
   fixture over HTTP.
2. From a popup click handler, request only `https://example.com/*`; verify it
   is granted without granting a different origin.
3. Register the generated runtime content-script asset for that origin, inject
   it into the already-open tab, and verify it runs only in the top frame.
4. Reload the page and restart Chrome; verify the registered script persists.
5. Verify whether the Shadow DOM data URL image renders under the restrictive
   CSP fixture. If it is blocked, replace the proof renderer with a canvas
   renderer before implementing the overlay controller.

No manual Chrome result has been claimed in this commit. This remains a hard
browser gate for Tasks 1 through 4.
