#!/bin/sh
set -eu

APP_PATH=${1:-desktop-wails/build/bin/Runwake.app}

if [ ! -d "$APP_PATH" ]; then
  echo "application bundle not found: $APP_PATH" >&2
  exit 1
fi
if [ -z "${APPLE_SIGN_IDENTITY:-}" ]; then
  echo "APPLE_SIGN_IDENTITY is not configured; leaving the application unsigned"
  exit 0
fi

codesign --force --deep --options runtime --timestamp --sign "$APPLE_SIGN_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [ -n "${APPLE_NOTARY_PROFILE:-}" ] || { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; }; then
  archive_path="${APP_PATH%/}.notary.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$archive_path"
  if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$archive_path" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
  else
    xcrun notarytool submit "$archive_path" --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  fi
  xcrun stapler staple "$APP_PATH"
  rm -f "$archive_path"
else
  echo "Apple notarization credentials are not configured; skipping notarization"
fi
