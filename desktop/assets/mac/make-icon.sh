#!/bin/bash
# Rebuilds EvoScientist.icns from robot.png (macOS only: swift, sips and
# iconutil come with the Command Line Tools). Run it after replacing
# robot.png, then commit the new EvoScientist.icns.
# Usage: ./make-icon.sh [copy-of-the-1024-px-drawing.png]
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swift make-icon.swift robot.png "$work/icon.png"
set_dir="$work/EvoScientist.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/icon.png" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/icon.png" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o EvoScientist.icns
# An optional argument keeps the 1024 px drawing, to look at.
if [ $# -ge 1 ]; then cp "$work/icon.png" "$1"; fi
echo "wrote $(pwd)/EvoScientist.icns"
