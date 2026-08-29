# Pixel Pincher

Pixel Pincher is a Chromium browser extension for placing a reference image over a web page while you compare a build against a design.

The project targets Chrome-compatible browsers first. Safari support will use Safari Web Extension conversion after the Chromium version is stable.

## Features

- Import a reference image (PNG, JPEG, WebP, or SVG) from your machine into the active tab.
- Overlay the reference above the page with per-site controls:
  - Show/hide the overlay.
  - Transparency from 0% to 100%.
  - Scale from 10% to 400% (slider, exact number input, or fit-to-viewport-width with restoration of the previous scale).
  - Color inversion.
  - X/Y placement with exact number inputs and arrow-key nudging.
  - Interaction mode: click-through (the page stays fully interactive) or drag (move the reference by dragging it).
- Per-site storage: each origin keeps its own image, settings, and placement, and the popup can clear a site's data.
- Site access is requested per origin through Chrome's optional host-permission prompt; restricted and browser-owned pages are unsupported and the popup says so.

## Keyboard commands

| Command | Default shortcut | Purpose |
| --- | --- | --- |
| Toggle reference visibility | `Alt+Shift+P` | Show or hide the overlay. |
| Nudge reference left | Unassigned | Move the reference left. |
| Nudge reference right | Unassigned | Move the reference right. |
| Nudge reference up | Unassigned | Move the reference up. |
| Nudge reference down | Unassigned | Move the reference down. |

Nudge commands ship without shortcuts so they do not conflict with browser or page shortcuts. Assign your own under `chrome://extensions/shortcuts`.

## Installing

WXT writes the extension to `dist/chrome-mv3` for both development and production builds.

1. Build the extension (`pnpm dev` for a development build or `pnpm build` for production).
2. Open `chrome://extensions` and enable Developer mode.
3. Choose **Load unpacked** and select the `dist/chrome-mv3` directory.

The production build includes the toolbar icons generated in `public/icon` (16, 32, 48, and 128 pixels). Regenerate them with `node scripts/generate-icons.mjs` after changing the icon design.

## Development

```sh
pnpm install
pnpm dev
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the development build. |
| `pnpm build` | Create a production extension build. |
| `pnpm check` | Type-check the project. |
| `pnpm lint` | Run ESLint. |
| `pnpm test` | Run unit tests. |

## Data and privacy

- References, settings, and placement are stored per origin with `chrome.storage.local` (the `unlimitedStorage` permission allows large reference images).
- The extension makes no network requests and does not collect or transmit page content.
- Incognito mode is disabled (`incognito: not_allowed`).

## Project layout

- `entrypoints/` — WXT entrypoints: background service worker, popup, and overlay content registration.
- `src/` — shared contracts plus background (commands, navigation, repository), content (overlay controller), and popup (controller, import) logic.
- `public/icon/` — production extension icons.
- `tests/` — Vitest unit tests for background, content, popup, and shared modules.
- `docs/plan.md` — the implementation plan and task breakdown.
