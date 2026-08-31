# Chromium release checklist

Use this checklist for each Chromium release candidate. It is a release record as
well as a procedure: replace the placeholders and change a row to **Passed** or
**Failed** only after recording the observed result. Do not infer manual results
from unit tests or a successful build.

## Release record

- Release version: `____________`
- Candidate commit: `____________`
- Build date and operator: `____________`
- Chrome stable version and platform: `____________`
- Other Chromium browser, version, and platform: `____________`
- Chrome result: **Not executed — requires manual browser interaction.**
- Other Chromium result: **Not executed — requires manual browser interaction.**
- Store package SHA-256: `____________`
- Rollback owner and approved previous version: `____________`

### Development-only audit exception — recorded 2026-08-31

`pnpm audit --prod` is clean. The full `pnpm audit` is **not clean**: it
reports the six development-only dependencies below. pnpm reports each finding
as `dev: true` and `bundled: false`; they are WXT development or browser-runner
tooling and are not reachable from, or packaged in, the MV3 archive built in
`dist/chrome-mv3`.

- `GHSA-w7jw-789q-3m8p` and `GHSA-395f-4hp3-45gv`: `.>wxt>web-ext-run>fx-runner>shell-quote`
- `GHSA-ph9p-34f9-6g65`: `.>wxt>web-ext-run>tmp`
- `GHSA-xcpc-8h2w-3j85`: `.>wxt>web-ext-run>firefox-profile>adm-zip`
- `GHSA-w5hq-g745-h8pq`: `.>wxt>web-ext-run>node-notifier>uuid`
- `GHSA-g7r4-m6w7-qqqr`: `.>wxt>esbuild`, `.>wxt>unimport>unplugin>esbuild`,
  and `.>wxt>vite-node>vite>esbuild`

WXT was upgraded to the newest compatible stable patch, `0.20.27`. WXT
`0.21.4` removes these advisories, but is incompatible with the current
entrypoint contract: `pnpm build` fails before bundling with `Cannot read
properties of undefined (reading 'get')`, and its debug transform replaces
`defineBackground(() => { ... })` with `defineBackground()`. Do not treat this
as a clean audit or add an incompatible override. Release remediation owner:
Jeremy Hull. This exception expires and must be reviewed by **2026-09-30**;
upgrade or migrate WXT before extending the deadline.

## Preflight and package

- [ ] Update the release version in `package.json` (and confirm the generated
      `manifest.json` has the same version). Do not release with a dirty worktree.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint`,
      `pnpm test`, and `pnpm build`; attach their logs to the release record.
- [ ] Inspect `dist/chrome-mv3/manifest.json`. It must have no required
      `host_permissions`; optional hosts must be only `http://*/*` and
      `https://*/*`; permissions must be `activeTab`, `storage`,
      `unlimitedStorage`, `scripting`, and `webNavigation`; and incognito must
      be `not_allowed`.
- [ ] Confirm the production archive contains the generated manifest, service
      worker, runtime overlay asset, popup assets, and 16, 32, 48, and 128 px
      icons. Archive the contents of `dist/chrome-mv3` only after this check.
- [ ] Install that exact production directory with **Load unpacked** before
      packaging it for the Chrome Web Store. Record all warnings shown by the
      extensions page; release only when there are none that need resolution.
- [ ] Review the Chrome Web Store listing: correct version, name, description,
      category, support contact, and screenshots that accurately show the
      popup and overlay. Screenshots must not expose customer pages, reference
      artwork, tokens, or personal data.
- [ ] Complete the privacy disclosure using the final disclosure text in the
      Store listing privacy disclosure section below. The disclosure must
      state: Pixel Pincher sends no telemetry; it does not upload images or
      page content; when the user submits an HTTP or HTTPS image URL, Pixel
      Pincher makes a user-directed URL import request to that URL, and the
      selected server receives normal network metadata for that request;
      Pixel Pincher stores the validated image bytes only in
      `chrome.storage.local`; it does not support incognito. Never state that
      the extension makes no network requests. Re-review the disclosure
      whenever permissions or data handling change.
- [ ] After Task 4 (bounded URL imports) is merged, verify that URL import
      requests use `credentials: "omit"` and `referrerPolicy: "no-referrer"`
      in source, and record the browser network-panel confirmation that URL
      imports send no cookies and no referrer in the release record.
- [ ] Before submission, compare the network and storage statements in the
      implementation, `README.md`, the Chrome Web Store listing, and the
      privacy questionnaire. All four must describe the same behavior: no
      telemetry, no uploads, and a user-directed URL import request only when
      the user submits an HTTP or HTTPS image URL.
- [ ] Upload the reviewed archive to the Chrome Web Store as a draft, verify
      the store's permission summary matches the manifest review, then submit
      only after the matrix below passes on both browsers.

## Store listing privacy disclosure

No store listing draft exists in this repository. Copy the following text
into the Chrome Web Store listing and privacy questionnaire, and keep it in
sync with `README.md` and the implementation:

> Pixel Pincher sends no telemetry and does not upload images or page
> content. The only network activity is a user-directed URL import request:
> when you submit an HTTP or HTTPS image URL, Pixel Pincher requests that
> URL, and the server you selected receives normal network metadata for that
> request. Pixel Pincher stores the validated image bytes only in
> `chrome.storage.local`. Importing a current-page `blob:` or `data:` URL
> makes no remote request. Pixel Pincher does not support incognito.

## Manual Chrome/Chromium matrix

**Execution status for this document:** every row below is **Not executed —
requires manual browser interaction.** No browser interaction was performed
while creating this checklist. Run every row against the same production build
loaded unpacked in current stable Chrome and one other Chromium browser (for
example Chromium, Edge, Brave, or Vivaldi). Record browser versions, result,
and any warning or defect in the release record.

| ID | Manual check and expected result | Chrome stable | Other Chromium |
| --- | --- | --- | --- |
| M01 | Load `dist/chrome-mv3` unpacked. The extension loads without warnings, toolbar icon is present, and popup opens. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M02 | On an HTTP page, choose **Enable on this site**. The browser prompts for that exact origin; grant it, import a reference, and verify the overlay appears in the current top-level document. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M03 | On a different HTTP or HTTPS origin, verify Pixel Pincher remains disabled until explicitly enabled. Deny its prompt and verify no reference is stored or displayed. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M04 | Import one valid PNG, JPEG, WebP, and SVG in turn. Each imports successfully, reports the correct intrinsic dimensions, and replaces only the current origin's reference. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M05 | Attempt every documented rejected input: GIF, non-image text/unknown type, MIME/content mismatch, malformed or undecodable image, source image above the 10 MiB limit or encoded data above the 14 MiB limit, and image above the 40-million-pixel decoded limit. Each is rejected and leaves the existing reference unchanged. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M06 | Verify visibility on and off, then transparency at 0%, 50%, and 100%. The image remains stored while hidden and opacity changes do not alter page layout. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M07 | Verify manual scale at 10%, 100%, and 600%; exact scale input; fit-to-viewport-width; and restoring the previous manual scale after fit width is turned off. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M08 | Verify inversion on and off. Verify click-through leaves the page interactive; in drag mode drag the image, verify its final document position, and press Escape during a second drag to verify cancellation. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M09 | Enter exact X/Y placement values, use arrow-key nudging (including Shift+arrow), and verify the overlay follows document coordinates while scrolling. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M10 | Use `Alt+Shift+P` to toggle visibility. Assign each unbound nudge command at `chrome://extensions/shortcuts` (or the browser equivalent), invoke it, and verify the expected one-pixel movement. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M11 | At browser zoom 80%, 100%, and 200%, repeat scroll, resize, scale, exact-placement, and drag checks. Verify no clipping, page scrollbars, or visual drift is introduced. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M12 | Reload the page, then fully restart the browser. An enabled origin and its reference restore; an origin without access remains inaccessible. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M13 | On a multi-route SPA, navigate with `history.pushState`, back/forward, a changed query string, and a hash-only change. Verify the reference and its site-scoped placement remain unchanged. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M14 | Revoke the enabled origin in the browser's extension site-access controls, reload, and verify the overlay, stored site data, and runtime registration are removed. Regrant access and verify normal enable/import behavior. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M15 | Serve the restrictive CSP fixture described in `docs/decisions/runtime-injection.md` and a page with aggressive global CSS. Verify the Shadow DOM overlay renders and remains isolated on both. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M16 | Open `file://`, `chrome://` (or browser-owned equivalent), the Chrome Web Store, an iframe-only target, and an incognito window. Verify unsupported states are explained or the extension is unavailable, with no injection or stored data. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |
| M17 | Use **Clear site data**, then verify the reference and controls disappear, the origin's `chrome.storage.local` records are gone in extension storage inspection, and its runtime registration is absent. | Not executed — requires manual browser interaction | Not executed — requires manual browser interaction |

## Rollback

1. Stop rollout or unpublish the affected Chrome Web Store version according to
   the store's release controls; do not overwrite evidence from the failed
   candidate.
2. Select the previously approved archive/version recorded above, verify its
   SHA-256 and its prior matrix record, then publish or roll it back through
   the Chrome Web Store.
3. Verify the restored version from the store on Chrome and the other Chromium
   browser, including extension load, popup open, site access, and an existing
   local reference.
4. Record the incident, affected version, rollback time, operator, and any
   user communication. Open a follow-up before attempting another release.
