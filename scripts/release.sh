#!/usr/bin/env bash
# pnpm release: store-ready zips for Chrome and Firefox, each checked by the
# bundle tests (egress scan, manifest), plus SHA-256 checksums.
#
#   .output/tether-<version>-chrome.zip     (Chrome, Edge, Brave, Arc)
#   .output/tether-<version>-firefox.zip
#   .output/tether-<version>-sources.zip    (for Firefox add-on review)
#   .output/SHA256SUMS
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec wxt zip
pnpm exec vitest run --config vitest.bundle.config.ts
pnpm exec wxt zip -b firefox --mv3
TETHER_BUNDLE=firefox-mv3 pnpm exec vitest run --config vitest.bundle.config.ts

cd .output
version=$(node -p "require('../package.json').version")
ls -1 tether-"$version"-*.zip
shasum -a 256 tether-"$version"-*.zip > SHA256SUMS
cat SHA256SUMS
