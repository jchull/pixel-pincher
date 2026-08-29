# Pixel Pincher

Pixel Pincher is a Chromium browser extension for placing a reference image
over a web page while comparing a build against a design. It targets
Chrome-compatible browsers first; Safari conversion is deliberately outside
this release.

## Features

- Import one PNG, JPEG, WebP, or SVG reference image for an enabled site.
- Show or hide the overlay; set transparency from 0% through 100%; scale from
  10% through 400%, use an exact scale, or fit the image to viewport width.
- Invert image colors, place it with exact X/Y CSS-pixel inputs, or drag it.
- Keep the page interactive in click-through mode.
- Keep image, controls, and placement per site origin; placement can differ by
  page path and query string.

## Setup and unpacked installation

Pixel Pincher requires Node.js 24 or later and uses pnpm 11.9.0.

```sh
pnpm install --frozen-lockfile
pnpm build
```

WXT writes the production extension to `dist/chrome-mv3`.

1. Open `chrome://extensions` in Chrome or the equivalent extensions page in
   another Chromium browser.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/chrome-mv3`.
4. Pin Pixel Pincher from the toolbar if desired, open its popup on an HTTP or
   HTTPS page, and choose **Enable on this site** before importing a reference.

Use `pnpm dev` for a development build. After changing the icon design, run
`node scripts/generate-icons.mjs`; production icons are generated at 16, 32,
48, and 128 pixels.

## Site access

Site access is optional and is granted only for the origin currently selected
in the popup (for example, `https://example.com/*`). Pixel Pincher does not
request broad required access to every site. Enabling a site lets the extension
register its top-frame overlay for that origin, including future reloads.

Denying access does not store the selected image. Revoking an origin's access
removes its registered overlay and its stored Pixel Pincher data. Reload the
page after granting access if a browser does not inject the overlay into an
already open document.

## Keyboard commands

| Command | Default shortcut | Purpose |
| --- | --- | --- |
| Toggle reference visibility | `Alt+Shift+P` | Show or hide the overlay. |
| Nudge reference left | Unassigned | Move the reference left. |
| Nudge reference right | Unassigned | Move the reference right. |
| Nudge reference up | Unassigned | Move the reference up. |
| Nudge reference down | Unassigned | Move the reference down. |

Nudge commands ship without shortcuts to avoid browser and page conflicts.
Assign them under `chrome://extensions/shortcuts` (or the equivalent browser
page).

## Local data, limits, and privacy

- Pixel Pincher stores references, settings, and placement per origin in
  `chrome.storage.local`. It requests `unlimitedStorage` so several site
  references can be retained locally.
- Source images are limited to 10 MiB; their encoded reference data URLs are limited to 14 MiB. Decoded images are
  limited to 40 million pixels. Invalid, unsupported, oversized, or
  undecodable images are rejected without replacing an existing reference.
- The extension makes no network requests and does not collect or transmit
  page content or reference images.
- Incognito is disabled (`incognito: not_allowed`).

Choose **Clear site data** in the popup to remove the current origin's image,
settings, placement overrides, and registered overlay.

## Troubleshooting and exclusions

- Pixel Pincher supports only top-level HTTP and HTTPS pages. It does not run
  on `file://` URLs, browser-owned pages such as `chrome://`, the Chrome Web
  Store, iframes, or incognito windows.
- If the popup says site access is required, select **Enable on this site** and
  accept the exact-origin permission prompt. If it was previously enabled,
  check the browser's extension site-access settings and regrant the origin.
- If no overlay appears after a successful grant, reload the tab. Confirm that
  the page is a supported top-level HTTP(S) page and that the extension remains
  enabled on the extensions page.
- If an import fails, use PNG, JPEG, WebP, or SVG within the data and pixel
  limits above. Animated GIF, text files, malformed images, and images with a
  MIME/type mismatch are rejected.
- If the overlay is misplaced, use the exact X/Y inputs or drag mode. Its
  placement is in document CSS pixels, so it follows page scrolling.

The first release excludes image diffing, multiple layers, side-by-side view,
image editing, annotations, rulers, cloud storage, sharing, accounts,
cross-device sync, and animated GIF.

## Development and verification

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the development build. |
| `pnpm build` | Create and assert a production extension build. |
| `pnpm check` | Type-check the project. |
| `pnpm lint` | Run ESLint. |
| `pnpm test` | Run unit tests. |

See [the Chromium release checklist](docs/release-checklist.md) for required
versioning, permissions, icon, screenshot, privacy, package, rollback, and
manual Chrome/Chromium release verification. Manual browser checks must be
recorded there; they are not implied by automated checks.

## Project layout

- `entrypoints/` — WXT entrypoints: background service worker, popup, and
  overlay content registration.
- `src/` — shared contracts plus background, content, and popup logic.
- `public/icon/` — production extension icons.
- `tests/` — Vitest unit tests.
- `docs/release-checklist.md` — release procedure and manual browser matrix.
- `docs/plan.md` — implementation plan and task breakdown.
