# Pixel Pincher

Pixel Pincher is a Chromium browser extension for placing a reference image over a web page while you compare a build against a design.

The project targets Chrome-compatible browsers first. Safari support will use Safari Web Extension conversion after the Chromium version is stable.

## Development

```sh
pnpm install
pnpm dev
```

WXT writes the Chromium build to `dist/chrome-mv3`. Load that unpacked directory from `chrome://extensions` with Developer mode enabled.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the development build. |
| `pnpm build` | Create a production extension build. |
| `pnpm check` | Type-check the project. |
| `pnpm lint` | Run ESLint. |
| `pnpm test` | Run unit tests. |

See [`docs/plan.md`](docs/plan.md) for the implementation plan.
