# Runtime injection preflight

**Date:** 2026-08-28
**Status:** passed; proof-only code deleted.

Task 0 built a temporary runtime content script, a popup proof action, and a
background proof relay, verified every check below in unpacked Chrome, and
then deleted the proof-only entrypoints, popup UI and styles, background
relay, proof modules, CSP fixture, proof tests, and proof build assertion in
the Task 0 completion commit. The details that bind later tasks are recorded
in `docs/plan.md` under “Task 0 proven details”.

## Proven seam

- The content entry used WXT `registration: "runtime"`, `runAt:
  "document_idle"`, `allFrames: false`, and no `matches` field. WXT 0.20
  emitted it at `content-scripts/runtime-proof.js` without adding a manifest
  `content_scripts` entry or required host permissions.
- The popup called `chrome.permissions.request` for the active tab's exact
  HTTP(S) origin (`<origin>/*`) directly inside the button click handler,
  with no background relay between the user gesture and the request.
- After the grant, the background registered the script for the exact origin
  with `persistAcrossSessions: true` and injected it into the active tab's
  top frame with `chrome.scripting.executeScript`.
- The renderer mounted one Shadow DOM host containing a visibly patterned
  data URL image and visible load/error status text.

## Dated manual Chrome results (2026-08-28)

Verified in unpacked Chrome loaded from `dist/chrome-mv3`, with the
restrictive CSP fixture served over HTTP at `http://localhost:8080`.

1. **Direct permission request:** on `https://css-tricks.com/`, clicking
   **Run runtime proof** granted `https://css-tricks.com/*` from the popup
   click handler and the popup reported successful registration and
   injection into the open tab.
2. **Exact-origin isolation:** an unrelated origin showed no proof badge and
   no site access; granting one exact origin did not grant another.
3. **Persistence:** after a page reload and after a full Chrome restart, the
   registration persisted. Reloading a granted origin ran the proof with no
   popup action, and the popup action still injected into the already-open
   active tab afterwards.
4. **Top frame only:** the registration used `allFrames: false`; the proof
   badge appeared on the top-frame page and no child-frame injection was
   observed.
5. **CSP rendering:** on the restrictive fixture, the Shadow DOM data URL
   image reported **loaded**. The image renderer is therefore the chosen
   path for the overlay; the `createImageBitmap` canvas fallback is not
   required.
6. **Stable asset path:** `pnpm build` emitted
   `dist/chrome-mv3/content-scripts/runtime-proof.js`, the same path used
   for runtime registration and injection.

## Reusable tooling kept

- JSDOM test environment (`vitest.config.ts`), Chrome API test doubles
  (`tests/setup.ts`), and a minimal tooling test that exercises both
  (`tests/tooling.test.ts`).
- CI (`.github/workflows/ci.yml`), `packageManager`, and Node engines in
  `package.json`.

## Note for Task 10

The CSP fixture was deleted with the proof code. If the release matrix needs
it again, recreate `tests/fixtures/csp-page.html` with

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src 'self'; style-src 'self'"
/>
```

served over HTTP, so only same-origin images are allowed.
