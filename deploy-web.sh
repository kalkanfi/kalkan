#!/usr/bin/env bash
# Build the web app and publish it to GitHub Pages (gh-pages branch).
# Usage: VITE_ARENA_ADDRESS=0x... VITE_SERVER_URL=https://....trycloudflare.com ./deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")/web"
npm run build
cd dist
touch .nojekyll
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy web"
git push -q -f "https://github.com/mrvipek259-ui/kalkan.git" gh-pages
rm -rf .git
echo "Published: https://mrvipek259-ui.github.io/kalkan/"
