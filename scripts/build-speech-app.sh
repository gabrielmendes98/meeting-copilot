#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rm -f "$root/dist/bin/speech-transcribe"
app="$root/dist/bin/Meeting Copilot Speech.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$root/native/speech-transcribe/Info.plist" "$app/Contents/Info.plist"
if [[ -f "$root/build/icon.icns" ]]; then
  cp "$root/build/icon.icns" "$app/Contents/Resources/AppIcon.icns"
fi
swiftc -parse-as-library -O \
  -o "$app/Contents/MacOS/SpeechTranscribe" \
  "$root/native/speech-transcribe/main.swift" \
  -framework AppKit \
  -framework AVFoundation \
  -framework Foundation \
  -framework Speech
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$app" >/dev/null 2>&1 || true
fi
