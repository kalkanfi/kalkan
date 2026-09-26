#!/usr/bin/env bash
# Build the web app and publish it to https://kalkanfi.github.io (repo kalkanfi/kalkanfi.github.io, branch main).
# Old hashed assets are kept, so a browser holding a cached index.html never hits a 404.
# Usage: VITE_SHIELD_ADDRESS=0x... VITE_LIVE_ADDRESS=0x... VITE_SERVER_URL=https://....trycloudflare.com ./deploy-web.sh
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
cd "$root/web"
npm run build
tmp="$(mktemp -d)"
git clone -q --depth 1 https://github.com/kalkanfi/kalkanfi.github.io.git "$tmp/site"
cp -R dist/. "$tmp/site/"
touch "$tmp/site/.nojekyll"
cd "$tmp/site"
git add -A
git commit -q -m "Deploy web" || true
git push -q origin main
rm -rf "$tmp"
echo "Published: https://kalkanfi.github.io/"
