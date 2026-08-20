# Meeting Copilot

A macOS menu-bar app: press a hotkey to capture **system audio** (Zoom/Meet/Teams), transcribe it in **English**, and send the text to a local Cursor agent (Composer 2.5 Fast). A floating overlay shows a short reply you can read and say in the meeting. A second hotkey captures a **screen region** and asks the same agent about the screenshot.

The Cursor IDE does **not** need to be open.

## Requirements

- macOS 13+
- Node 20+
- Xcode Command Line Tools (`xcode-select --install`) — needed to compile the Swift helpers
- [CURSOR_API_KEY](https://cursor.com/dashboard/integrations)
- Transcription: SpeechAnalyzer on macOS 26+ **or** [OpenAI](https://platform.openai.com/api-keys) **or** [Groq](https://console.groq.com/keys)

## Setup

```bash
cd ~/Documents/meeting-copilot
cp .env.example .env
# edit .env: CURSOR_API_KEY is required
# STT_PROVIDER=macos needs no STT API key
npm install
npm start
```

### Transcription (`STT_PROVIDER`)

| Value | Engine | Extra key |
| --- | --- | --- |
| `macos` | SpeechAnalyzer (`en-US`, on-device, macOS 26+) | none |
| `openai` | `gpt-4o-mini-transcribe` | `OPENAI_API_KEY` |
| `groq` | `whisper-large-v3-turbo` | `GROQ_API_KEY` |
| `auto` | Groq → OpenAI → macOS | depends on fallback |

Transcription language is always **English**. No autodetect.

On the first capture, macOS asks for **Screen Recording**. With `macos`, it also asks for **Speech Recognition**:

1. System Settings → Privacy & Security → Screen Recording
2. System Settings → Privacy & Security → Speech Recognition
3. Enable **Terminal** / **Electron** / **Meeting Copilot Speech** / **Meeting Copilot**

Without Screen Recording, captured audio is silent. Without Speech Recognition, SpeechAnalyzer fails.

The first `macos` run may download Apple’s on-device English model (needs network once). After that it stays local.

To test with YouTube: keep the video **playing with volume**, on the main display, and record a clip that includes **speech** (not music only).

On the first `macos` transcription, macOS should show a prompt for **Meeting Copilot Speech**. That is the app that appears under Speech Recognition (not Electron). If an earlier attempt failed silently and the list is still empty, reset the permission cache and try again:

```bash
tccutil reset SpeechRecognition
npm start
```

## Using it in a meeting

1. The app shows a waveform icon in the menu bar.
2. `Option+Space` starts recording system audio. The overlay shows **Recording**.
3. `Option+Space` again stops, transcribes, and asks the agent for a spoken English reply.
4. Read the overlay and speak. Esc or click dismisses it.

The shortcut is configurable in `.env` (`HOTKEY=Alt+Space`). In Electron, Option on Mac is `Alt`.

## Screenshot questions

1. `Option+Shift+Space` opens the macOS region selector (same gesture as Cmd+Shift+4). Esc cancels.
2. After you capture an area, the overlay shows **Thinking**, then the reply.
3. Multiple choice: the option plus a short justification. Open questions: 2–4 short sentences, in the language of the screenshot.
4. The reply is copied to the clipboard so you can paste with Cmd+V.

The shortcut is configurable in `.env` (`SCREENSHOT_HOTKEY=Alt+Shift+Space`). It is ignored while audio is recording or the agent is already busy.

Screen Recording permission is the same one used for system audio.

## How it works

1. A Swift helper (`audio-capture`) uses ScreenCaptureKit (`capturesAudio`, `excludesCurrentProcessAudio`) and writes a temporary WAV.
2. The WAV is transcribed in English: SpeechAnalyzer on the Mac, OpenAI, or Groq.
3. Audio clips and screenshots go to a warmed-up Cursor agent. A `preToolUse` hook (in `agent-home/`, not the repo root) denies tools.
4. The WAV and screenshot PNG are deleted afterwards.

Typical time after the second keypress (20–40s clip): about 4–8s on cloud STT; SpeechAnalyzer is usually similar or faster after the model is installed.

## Limits

- Captures the system mix (other people on the call). Your headset mic usually is not included.
- Zoom/Meet may require an extra in-app recording permission.
- Transcribing a meeting may have consent implications (company policy / local law).
