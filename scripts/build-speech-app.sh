#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rm -f "$root/dist/bin/speech-transcribe"
app="$root/dist/bin/Meeting Copilot Speech.app"
mkdir -p "$app/Contents/MacOS"
cp "$root/native/speech-transcribe/Info.plist" "$app/Contents/Info.plist"
swiftc -parse-as-library -O \
  -o "$app/Contents/MacOS/SpeechTranscribe" \
  "$root/native/speech-transcribe/main.swift" \
  -framework AppKit \
  -framework Foundation \
  -framework Speech
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$app" >/dev/null 2>&1 || true
fi
