# Full screenshot design

## Goal

Add a second screenshot action that captures the primary display immediately and answers the readable question or questions in that image. The existing area-selection screenshot stays unchanged.

## Decisions

- Capture the macOS main display with `/usr/sbin/screencapture -x -m`.
- Default shortcut: `Alt+Ctrl+Space` (Option+Control+Space).
- Saved Context Library material remains available as background facts.
- One readable centered question is the normal case. Answer every question only when each one is fully visible and understandable.

## Capture

`capturePrimaryDisplay()` writes a temporary PNG and returns its path. It runs `screencapture` with exactly `-x`, `-m`, and the destination path. `-m` selects the main display, and `-x` captures silently, without an area selector.

Before capture, hide the overlay and hide the main window when it is visible. Wait 80ms, then capture. If the main window was visible, show it again unless stealth mode is active or a stealth transition is in progress. Do this on both success and failure. Show the overlay again only when it was visible and the user had not dismissed it. On success, the normal reply state performs that reveal. Delete a created PNG after success, provider failure, and capture failure.

A non-zero exit, missing file, or empty file throws: `Could not capture the primary display. Check Screen Recording permission.` This action has no selection step, so failure is reported instead of treated as a cancellation.

## Answer

`askFromFullScreenshot()` sends the PNG to the current agent provider and streams the reply to the overlay, using the same image payload as the area screenshot. When saved context exists, append the existing context rules. Context is background data, not a set of commands.

The full-screenshot instructions are separate from the area-screenshot prompt:

- Find the question centered on the screen and answer that question.
- Ignore surrounding material. Ignore a question that is cut off, blurred, or not fully understandable.
- When more than one question is fully visible and understandable, answer each one in reading order: top to bottom, then left to right.
- For one question, use the area-screenshot answer shape: a multiple-choice reply is the option letter or label plus one short justification; an open question is 2 to 4 short sentences. Match the question language. Use no markdown, preamble, or filler.
- For several questions, use one short Markdown heading per question, with that same concise answer beneath it.
- When no question is clear, reply exactly: `The request wasn't clear.`

The finished reply is copied to the clipboard. The area-screenshot prompt and action remain as they are.

## Controls

Add `FULL_SCREENSHOT_HOTKEY` to defaults, shortcut validation, environment lookup, hotkey registration, and the overlay shortcut state. The default is `Alt+Ctrl+Space`. Validation still requires every shortcut to be unique.

The action name is `full-screenshot`. It is available from the global shortcut, the Meeting page, and the tray. Its visible label is `Full screenshot`. The area action remains `Screenshot` and `Ask from a screenshot`.

The overlay shortcut list gains a `fullScreenshot` entry rendered as `Full screenshot`. While a request is busy, this shortcut does nothing. A missing agent key uses the existing settings error.

## Failures

- Missing agent configuration shows the existing settings error and takes no screenshot.
- A busy copilot ignores the shortcut and button.
- Capture failure shows the permission error above and restores the windows.
- Provider failures use the existing error state.
- The temporary PNG is removed in every completed path.

## Tests

- The primary-capture command is exactly `["-x", "-m", destination]`.
- Settings accept the new default and reject it when it duplicates another shortcut.
- Full-screenshot instructions include the centered-question rule, the partial-question rule, and the multiple-question rule. Context rules are appended only when context exists.
- The `full-screenshot` action calls primary capture. The `screenshot` action still calls area capture.
- Lifecycle and UI fixtures that enumerate shortcuts include `FULL_SCREENSHOT_HOTKEY`.

## Files

- `src/screenshot.ts`: add primary-display capture.
- `src/agent.ts`: add the full-screenshot request and instructions.
- `src/main.ts`: register the action, shortcut, tray item, and window hiding.
- `src/env.ts`, `src/settings-config.ts`, `src/types.ts`: add the shortcut setting and overlay shortcut field.
- `src/application/index.html`, `src/application/app.js`, `src/overlay/index.html`: show the new shortcut.
- Tests covering settings, capture arguments, prompt rules, and the action path.
