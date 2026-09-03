#!/usr/bin/env bash
set -euo pipefail

release_dir="dist/chrome-mv3"
archive="dist/pixel-pincher-$(node -p "require('./package.json').version").zip"

CI=true pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm audit --prod
pnpm audit || true
git diff --check

test -f "$release_dir/manifest.json"
jq . "$release_dir/manifest.json"
rm -f "$archive"
(
  cd "$release_dir"
  zip -qr "../$(basename "$archive")" .
)
shasum -a 256 "$archive"
printf 'Archive: %s\n' "$archive"
