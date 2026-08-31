# Pixel Pincher

Pixel Pincher is a Chromium extension for aligning a reference image with a live web page. It keeps the reference over the page while you adjust its placement, opacity, scale, and interaction mode. I built this to solve a problem for myself. I ask for no donations, no adware, no spam. Enjoy, and contributions are welcome. 

## Features

- One reference image per enabled site origin: PNG, JPEG, WebP, or SVG.
- Import by dropping or pasting an image into the import target, clicking its **click to choose** link, or entering an `http`, `https`, current-page `blob`, or `data:` image URL and selecting **Import URL** (or pressing Enter).
- A draggable, collapsible in-page control panel. Its position is saved per site.
- Overlay controls for opacity, exact scale, fit-to-viewport width, inversion, and X/Y placement.
- Live X/Y updates while the overlay is dragged.
- **Hide/Show** and **Lock/Unlock** toggle buttons. The overlay starts unlocked for dragging; lock it for click-through use.
- Overlay placement shared across every page on the enabled site origin.
- Keyboard commands for visibility and placement nudging.

## Install from source

Pixel Pincher requires Node.js 24 or later and pnpm 11.9.0.

```sh
pnpm install --frozen-lockfile
pnpm build
```

WXT writes the extension to `dist/chrome-mv3`.

1. Open `chrome://extensions` in Chrome or another Chromium browser.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `dist/chrome-mv3`.
4. Open the Pixel Pincher toolbar popup on an HTTP or HTTPS page and select
   **Enable on this site**.
5. Use the in-page panel to import and adjust a reference image.

The toolbar popup is also the fallback way to show or hide the in-page panel.

## Site access and privacy

Pixel Pincher requests optional access only for the origin currently open in the
active tab, such as `https://example.com/*`. It does not request blanket access
to every website. Revoking that permission removes the registered overlay and
Pixel Pincher data for the origin.

References, settings, and placement are stored locally in `chrome.storage.local`.
Pixel Pincher sends no telemetry and does not upload images or page content.
The only network activity is a user-directed URL import request: when you
submit an HTTP or HTTPS image URL, Pixel Pincher requests that URL, and the
selected server receives normal network metadata for that request. The
validated image bytes are stored only in `chrome.storage.local`. Importing a
current-page `blob:` or `data:` URL makes no remote request. Remote servers
must allow the browser to fetch the image (for example, with appropriate CORS
headers).

Source images are limited to 10 MiB, encoded data URLs to 14 MiB, and decoded
images to 40 million pixels. Invalid or unsupported files do not replace an
existing reference.

## Keyboard commands

| Command | Default shortcut | Purpose |
| --- | --- | --- |
| Toggle reference visibility | `Alt+Shift+P` | Show or hide the overlay. |

Assign unbound shortcuts under `chrome://extensions/shortcuts`.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run a development build. |
| `pnpm build` | Create and assert a production extension build. |
| `pnpm check` | Type-check the project. |
| `pnpm lint` | Run ESLint. |
| `pnpm test` | Run unit tests. |

See [the Chromium release checklist](docs/release-checklist.md) for manual
browser verification before a release.

## Limitations

Pixel Pincher supports only top-level HTTP and HTTPS pages. It does not run on
`file://` URLs, browser-owned pages such as `chrome://`, the Chrome Web Store,
iframes, or incognito windows. The first release does not include image diffing,
multiple layers, annotations, cloud storage, sharing, accounts, cross-device
sync, or animated GIF support.

## License

Pixel Pincher is licensed under the [Apache License 2.0](LICENSE). Third-party
notices, including the vendored Lucide icons, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
