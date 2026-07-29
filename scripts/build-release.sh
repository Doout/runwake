#!/bin/sh
set -eu

VERSION=${1:-0.1.0}
if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "version must use semantic version form, for example 0.1.0" >&2
  exit 1
fi
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
DIST="$ROOT/dist"
LDFLAGS_SERVER="-s -w -X github.com/Doout/runwake/internal/app.Version=$VERSION"

rm -rf "$DIST"
mkdir -p "$DIST"

build_server() {
  os=$1
  arch=$2
  extension=$3
  name="runwake-$VERSION-$os-$arch"
  work="$DIST/$name"
  mkdir -p "$work"
  echo "building $name"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="$LDFLAGS_SERVER" -o "$work/runwake$extension" ./cmd/runwake
  cp "$ROOT/README.md" "$ROOT/LICENSE" "$work/"
  if [ "$os" = windows ]; then
    (cd "$DIST" && zip -qr "$name.zip" "$name")
  else
    tar -czf "$DIST/$name.tar.gz" -C "$DIST" "$name"
  fi
  rm -rf "$work"
}

build_server linux amd64 ""
build_server linux arm64 ""
build_server darwin amd64 ""
build_server darwin arm64 ""
build_server windows amd64 .exe

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIST" && sha256sum ./*.tar.gz ./*.zip > SHA256SUMS)
else
  (cd "$DIST" && shasum -a 256 ./*.tar.gz ./*.zip > SHA256SUMS)
fi
echo "release artifacts written to $DIST"
