# Stealth compatibility

Reviewed on 2026-10-12. Development machine: macOS 26.6.2; Electron 41.7.1.

## Implemented behavior

- Accessory activation policy, hidden Dock / Cmd+Tab entry, destroyed tray while stealth is active.
- Protected workspace and reply windows, omitted from Mission Control.
- Non-focusable, click-through reply overlay; global show/hide, movement, scrolling, opacity and reset shortcuts.
- Explicit hiding survives streaming updates. Exiting stealth remains available while an agent is busy.

## Local display-capture results

The native diagnostic in `native/screen-protection-check/main.swift`, driven by `scripts/verify-screen-protection.cjs`, uses a display filter with **no excluded windows or applications**. It samples the test-window region, returning only red/gray pixel ratios; no screen images are saved. An unprotected gray window sits beneath the red marker. The gray baseline and unprotected red marker verify that the test is actually capturing the target region.

On the development Mac, all three paths returned 100% gray for the baseline, 100% red for the unprotected marker, and 100% gray / 0% red after content protection was enabled:

| API / scenario | Result |
| --- | --- |
| SCScreenshotManager | Protected marker excluded |
| Newly started SCStream | Protected marker excluded |
| SCStream already running while protection toggles | Protected marker excluded |

These are local observations, not an end-to-end Meet, Slack or Teams compatibility guarantee. The source filter models display capture, with a cropped source rectangle covering only the test marker. It does not request explicit exclusion of the app or marker.

To reproduce, compile the helper (macOS 14+ with screen recording access):

```sh
swiftc -parse-as-library -module-cache-path /tmp/meeting-copilot-swift-cache -o /tmp/meeting-copilot-capture-check native/screen-protection-check/main.swift -framework Foundation -framework CoreGraphics -framework ScreenCaptureKit -framework CoreMedia -framework CoreImage
node_modules/.bin/electron scripts/verify-screen-protection.cjs /tmp/meeting-copilot-capture-check
```

## Documentation caveats

The current implementation uses Electron's `setContentProtection(true)`. Electron maps this to `NSWindow.sharingType = NSWindowSharingNone` on macOS and explicitly documents that ScreenCaptureKit can capture protected windows anyway:

https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows

Apple now describes `NSWindow.SharingType.none` as a legacy constant macOS no longer uses:

https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum

Despite these documentation caveats, the diagnostic observed exclusion on this Mac. Moving the same window flag into a native helper would not, by itself, establish stronger exclusion. Hiding from Mission Control, changing opacity or window level, and ignoring mouse events are interaction or presentation controls; they do not establish screen-capture exclusion.

InterviewCoder's current website advertises screen-share invisibility and click-through behavior, but does not document its current capture-exclusion implementation. Its claim is not a compatibility test for this app:

https://www.interviewcoder.co/

A public fork of older Interview Coder source uses Electron `setContentProtection(true)` and window flags. It is a reference for interaction behavior, not evidence about the current proprietary product:

https://github.com/PEAandDA/interview-coder/blob/main/electron/main.ts

## Capture ownership

Apple's `SCContentFilter(display:excludingWindows:)` explicitly excludes windows from a capture stream owned by the capturing application:

https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingwindows:)

A separately shared clean desktop preview could use this API to omit our app before the meeting application receives the preview. It would require sharing that preview window instead of choosing the entire display. The user explicitly requires entire-display sharing, so this workaround is outside the accepted scope. Our app cannot apply its own stream filter to a screen-share stream owned by Meet, Slack or Teams.

## Validation scope

Automated tests cover state transitions, protection calls, shortcut conflicts and recovery, hidden streaming, movement bounds, opacity limits and scroll messages. The separate native diagnostic verifies pixel exclusion locally as described above. Automated mocks do not establish OS focus behavior, and no end-to-end remote sharing result has been verified for Meet, Slack or Teams.

For remote validation, check full-display, application-window and browser-tab sharing separately, observing an independent receiver. Record macOS version, meeting application/browser version, sharing target and whether the overlay is visible during streaming, movement and opacity changes. Permission prompts and native region selectors are not protected app windows.
