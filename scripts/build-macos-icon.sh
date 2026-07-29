#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
	exit 0
fi

project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
source_icon="$project_dir/desktop-wails/build/appicon.png"
app_bundle="$project_dir/desktop-wails/build/bin/Runwake.app"
bundle_icon="$app_bundle/Contents/Resources/iconfile.icns"
work_dir=$(mktemp -d /tmp/runwake-macos-icon.XXXXXX)
iconset_dir="$work_dir/Runwake.iconset"

cleanup() {
	rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir "$iconset_dir"
sips -z 16 16 "$source_icon" --out "$iconset_dir/icon_16x16.png" >/dev/null
sips -z 32 32 "$source_icon" --out "$iconset_dir/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$source_icon" --out "$iconset_dir/icon_32x32.png" >/dev/null
sips -z 64 64 "$source_icon" --out "$iconset_dir/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$source_icon" --out "$iconset_dir/icon_128x128.png" >/dev/null
sips -z 256 256 "$source_icon" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$source_icon" --out "$iconset_dir/icon_256x256.png" >/dev/null
sips -z 512 512 "$source_icon" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$source_icon" --out "$iconset_dir/icon_512x512.png" >/dev/null
cp "$source_icon" "$iconset_dir/icon_512x512@2x.png"
iconutil -c icns "$iconset_dir" -o "$bundle_icon"
codesign --force --deep --sign - "$app_bundle" >/dev/null
