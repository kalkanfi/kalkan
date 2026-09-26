#!/usr/bin/env bash
# Build the web app and publish it to https://kalkanfi.github.io (repo kalkanfi/kalkanfi.github.io, branch main).
# Usage: VITE_SHIELD_ADDRESS=0x... VITE_LIVE_ADDRESS=0x... VITE_SERVER_URL=https://....trycloudflare.com ./deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")/web"
npm run build
cd dist
touch .nojekyll
git init -q -b main
git add -A
git commit -q -m "Deploy web"
git push -q -f "https://github.com/kalkanfi/kalkanfi.github.io.git" main
rm -rf .git
echo "Published: https://kalkanfi.github.io/"
