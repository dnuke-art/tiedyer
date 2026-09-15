#!/bin/sh
# Regenerate the iOS app icon from the simulator (dev server on :5179 must be running):
# render the spiral demo at a light colour depth, crop the cloth out of the canvas,
# and lift saturation a little so the icon reads at 60 px.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
node tools/icon.mjs "$tmp/src.png"
magick "$tmp/src.png" -gravity center -crop 1:1 +repage -crop 93x93%+0+0 +repage \
  -resize 1024x1024 -modulate 105,135 -alpha off \
  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
rm -rf "$tmp"
echo "wrote ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
