# Meeting Copilot

A macOS application with a Dock window and menu-bar controls: press a hotkey to capture **system audio** (Zoom/Meet/Teams), transcribe it in **English**, and send the text to a configurable AI provider (OpenAI by default). A floating overlay shows a short reply you can read and say in the meeting. A second hotkey captures a **screen region** and asks the same agent about the screenshot.

OpenAI and Cursor are supported. The Cursor IDE does **not** need to be open when using Cursor.

## Requirements

- macOS 13+
- Node 20+
- Xcode Command Line Tools (`xcode-select --install`) — needed to compile the Swift helpers
- `AGENT_API_KEY` from [OpenAI](https://platform.openai.com/api-keys) (default) or [Cursor](https://cursor.com/dashboard/integrations)
- Transcription: SpeechAnalyzer on macOS 26+ **or** [OpenAI](https://platform.openai.com/api-keys) **or** [Groq](https://console.groq.com/keys)

## Setup

```bash
cd ~/Documents/meeting-copilot
cp .env.example .env
# edit .env: AGENT_API_KEY must be a key from the selected agent provider
# STT_PROVIDER=macos needs no STT API key
npm install
npm start
```

### Agent provider (`AGENT_PROVIDER`)

| Value              | Default model         | Required settings            |
| ------------------ | --------------------- | ---------------------------- |
| `openai` (default) | `gpt-4.1-mini`        | `AGENT_API_KEY` (OpenAI key) |
| `cursor`           | `composer-2.5` (Fast) | `AGENT_API_KEY` (Cursor key) |

`AGENT_MODEL` overrides the selected provider's model. If switching from the example's OpenAI configuration to Cursor, also change `AGENT_MODEL` to `composer-2.5` or remove it to use Cursor's default. Existing installations now default to OpenAI, even if a Cursor key is present; set `AGENT_PROVIDER=cursor` to continue using Cursor.

`AGENT_API_KEY` is the only agent credential setting. When switching providers, replace its value with a key issued by the selected service. New provider protocols can be added through adapters behind the shared interface.

Replace the former agent setting (`OPENAI_API_KEY` or `CURSOR_API_KEY`) with `AGENT_API_KEY` in existing `.env` files. Cloud transcription uses `STT_PROVIDER_API_KEY`, allowing it to use a different service from the agent. Move any former transcription key (`OPENAI_API_KEY` or `GROQ_API_KEY`) to `STT_PROVIDER_API_KEY` and select its service with `STT_PROVIDER`.

The default OpenAI model accepts text and images and supports streaming ([official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini)). Agent credentials are checked for the selected provider only. `STT_PROVIDER` remains independent; selecting OpenAI for answers does not change the transcription setting.

### Transcription (`STT_PROVIDER`)

| Value    | Engine                                         | Extra key                           |
| -------- | ---------------------------------------------- | ----------------------------------- |
| `macos`  | SpeechAnalyzer (`en-US`, on-device, macOS 26+) | none                                |
| `openai` | `gpt-4o-mini-transcribe`                       | `STT_PROVIDER_API_KEY` (OpenAI key) |
| `groq`   | `whisper-large-v3-turbo`                       | `STT_PROVIDER_API_KEY` (Groq key)   |
| `auto`   | OpenAI if the STT key is set, otherwise macOS  | OpenAI key when set                 |

`STT_PROVIDER_API_KEY` is the only transcription credential setting and is independent of `AGENT_API_KEY`. For example, use `AGENT_PROVIDER=cursor` with a Cursor `AGENT_API_KEY`, and `STT_PROVIDER=openai` with an OpenAI `STT_PROVIDER_API_KEY`. `auto` assumes an OpenAI key; choose `STT_PROVIDER=groq` explicitly for a Groq key. macOS transcription needs no API key.

Transcription language is always **English**. No autodetect.

Transcription configuration and credential validation share one resolver. `speech` and `local` remain aliases for `macos`. Unknown `STT_PROVIDER` values produce a configuration error instead of silently selecting another service. The existing transcription keys remain independent of `AGENT_API_KEY`.

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

With `STT_PROVIDER=macos` (on-device SpeechAnalyzer):

1. On first launch, a setup screen blocks the workspace and floating widget until macOS reports Screen Recording and Microphone access as allowed. On-device transcription also requires Speech Recognition for **Meeting Copilot Speech**. Use **Allow access** on each row; denied or restricted permissions open the matching System Settings pane. Return and click **Check again**, then **Continue**. If macOS requires quitting and reopening, restart the app. Setup does not record audio or download speech models. Permission checks use the OS state rather than a saved checkbox; revoking access brings setup back, and hotkeys and IPC actions cannot bypass it. Cloud transcription does not require Speech Recognition.

   After setup, the app opens a full workspace window and appears in the Dock, alongside its ribbon M menu-bar icon. The **Meeting** page provides listening, contextual chat, screenshot, and copy controls. Closing the workspace keeps the app and meeting session running; reopen it from the Dock or **Open Meeting Copilot** in the tray menu. Use **Quit** to stop the app.

   **Settings** configures the AI provider, model, API keys, transcription provider, and shortcuts. The Model dropdown displays names and updates for the selected provider: OpenAI includes GPT-6.2 Sol (recommended starting point), GPT-6.1 Terra (screenshots), GPT-6 Luna (lower cost), GPT-6.2 Astra (complex questions), GPT-5.4 mini, and the existing GPT-4.1/GPT-4o choices; Cursor includes Composer 2.5 and Automatic. Switching providers remembers your selections while editing. Existing custom model IDs remain available through **Custom model…**, where you can also enter another provider-supported ID. Availability depends on your provider account. Save while idle to apply changes immediately. Shortcut conflicts leave your previous settings intact. Keys are encrypted using Electron's macOS-backed `safeStorage`; the renderer receives only whether a key exists. Saved settings in the app's user-data directory override `.env` on subsequent launches. Leaving an API-key field blank preserves the existing key.

   **Context library** accepts multiple PDF, DOCX, PowerPoint (`.pptx`), TXT, Markdown, CSV, JSON, and source-code documents together, plus freeform text in **Direct context**. Click **Save text** to apply or clear your notes. Readable document text is extracted locally and saved between launches; all ready documents and saved notes are sent together to the selected AI provider with live chat and screenshot requests according to your selected mode. Imported documents are snapshots: remove and re-add to update them. Removing an entry leaves the original file intact. Files can be up to 20 MB each, with a combined limit of 120,000 characters for documents and notes; content is never silently truncated. Failed imports display a reason and are excluded, while other documents remain usable. PowerPoint imports slide text in presentation order, excluding images and speaker notes. Source-code references must be UTF-8 text; common extensions including TS/JS, Python, Swift, Java, C/C++, Go, Rust, SQL, and YAML are supported. Scanned PDFs need OCR first, and password-protected or invalid documents may not be readable. Existing file references remain usable as long as their originals are accessible; re-import them to save a snapshot.

   **Stealth mode** (macOS): use **Enter stealth mode** on the Meeting page, the menu-bar action, or `Option+Shift+S`. The workspace hides, the Dock / Cmd+Tab entry and menu-bar icon disappear, both windows are hidden from Mission Control, and the floating reply overlay stays visible locally. In stealth, the overlay is non-focusable and click-through: clicking it interacts with the meeting or editor underneath. All meeting and overlay hotkeys continue working. Press `Option+Shift+S` again to restore the workspace, Dock, and menu-bar icon, including while an agent is busy. Change shortcuts in Settings; stealth is unavailable if the restore shortcut cannot be registered. `Cmd+Backslash` hides or shows the overlay without exiting stealth, retaining its latest content; streaming updates will not reveal a panel you explicitly hid. Outside stealth, Esc also hides the panel. Reopening the application while stealth is active does not reveal the workspace. Stealth is not persisted: restarting returns to normal mode.

   Screen-share exclusion is **best effort**, not a guarantee of invisibility in Google Meet, Slack, or Microsoft Teams. Stealth uses Electron’s `setContentProtection(true)` on both app windows; [Electron documents that macOS ScreenCaptureKit can still capture protected windows](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows). Share a specific meeting/application window and verify the remote view before relying on exclusion. Native permission prompts and the screenshot selection interface are not protected app windows. To quit from Terminal while hidden, find the main process with `pgrep -fl 'Meeting Copilot|Electron'`, then run `kill <PID>` using the main app PID. When using `npm run dev` or `npm start`, you can also stop the launch terminal with Ctrl+C.

   **Modes**, in the sidebar or the widget’s **••• → Modes & files** menu, provide built-in instructions for meetings, interviews, sales, lectures, and technical work. Select a built-in mode and click **Customize mode** to create an editable copy with its instructions already filled in. The split view shows templates on the left and meeting context plus reference files on the right. Use **Add reference files** to import documents directly while preserving your draft instructions; newly imported readable files are selected for that mode. Choose its reference documents, then **Save and activate**. Opening or cancelling the editor keeps the current mode active. New template copies start with no selected reference documents; existing custom modes retain their prior selection. The separate **Context library** remains available for shared notes and managing all imported documents. Custom modes can be edited or deleted; built-in templates stay available.

2. `Cmd+Shift+Backslash` starts or ends listening. Use **Pause audio** during a session to pause capture without closing the session, and **Resume audio** to continue.
3. Type a message and press `Cmd+Enter` to ask AI. Use **Use screen context** to include the current display. During a session you can submit without typing to ask about the latest context.
4. Ending a session with a transcript saves it under **History** and requests meeting notes from the configured AI provider.

| Action | Default on macOS |
| --- | --- |
| Show or hide overlay | `Cmd+Backslash` |
| Ask about screen or audio | `Cmd+Enter` |
| New chat | `Cmd+R` |
| Open Settings | `Cmd+Comma` |
| Start or end session | `Cmd+Shift+Backslash` |
| Move overlay | `Cmd+Arrow` |
| Scroll reply | `Cmd+Shift+Up/Down` |
| Toggle stealth or restore app | `Option+Shift+S` |
| Change opacity | `Option+Shift+-` / `Option+Shift+=` |
| Center panel / reset opacity | `Option+Shift+0` |

Change, clear, or reset shortcuts in **Settings**. The stealth restore shortcut requires a binding. The app updates settings that still use the previous defaults and preserves other custom bindings.

Overlay movement uses 40-pixel steps and stays inside a display’s working area. Resizing for streamed replies preserves the panel’s position. Set **Settings → Overlay appearance → Default opacity (%)** to a whole percentage from 30 to 100 (default: 100). Saving applies it immediately and persists it for future launches; reset restores this saved default after temporary keyboard adjustments. You can also set `OVERLAY_OPACITY=100` in `.env` for the initial default. All overlay controls are configurable under **Settings → Overlay shortcuts** and work without focusing the panel.

The opacity setting controls the background; text and header shortcut symbols use twice that opacity, capped at 100% (35% background → 70% text; 30% → 60%). The header displays Mac key symbols for recording, Ask AI, screenshots, show/hide, and—in stealth—restoring the app. Clicking the panel no longer dismisses it.

## Screenshot questions

1. `Option+Shift+Space` opens the macOS region selector (same gesture as Cmd+Shift+4). Esc cancels.
2. After you capture an area, the overlay shows **Thinking**, then the reply.
3. Multiple choice: the option plus a short justification. Open questions: 2–4 short sentences, in the language of the screenshot.
4. The reply is copied to the clipboard so you can paste with Cmd+V.

The shortcut is configurable in `.env` (`SCREENSHOT_HOTKEY=Alt+Shift+Space`). It is ignored while the agent is busy (an action or screenshot in flight). You can still screenshot while macos listening is active.

Screen Recording permission is the same one used for system audio.

## How it works

1. A Swift helper (`audio-capture`) uses ScreenCaptureKit (`capturesAudio`, `excludesCurrentProcessAudio`). With `macos` it writes rotating WAV chunks; with cloud STT it writes one file until you stop.
2. English transcription: SpeechAnalyzer on the Mac (`--watch` process for live macos), or OpenAI / Groq for a finished clip.
3. Audio transcripts and screenshots go through a shared agent interface to the configured provider. OpenAI uses stateless, streamed Chat Completions without tools. Cursor retains its local agent session.
4. Temporary WAV chunks and screenshot PNGs are deleted afterwards.

Typical time after a macos action (`Option+1` / `2` / `3`): a few seconds for the flushed tail plus the agent. Cloud STT after `Option+1` / `2` / `3` on a 20–40s clip: about 4–8s.

## Provider architecture and development

The application uses the Strategy pattern with provider adapters and a factory:

- `src/agent.ts` owns meeting prompts and builds provider-independent requests.
- `src/providers/types.ts` defines the `AgentProvider` contract (warm, answer, dispose) and accumulated-text streaming callback.
- `src/providers/service.ts` owns lazy initialization, concurrent warm-up, retry after initialization failure, and shutdown.
- `src/providers/config.ts` resolves and validates environment configuration.
- `src/providers/index.ts` creates only the selected adapter, loading its SDK lazily.
- `src/providers/openai.ts` and `cursor.ts` translate requests and streams for their SDKs.

To add a provider with another protocol, implement `AgentProvider`, extend the configuration union and validation, and add a factory branch. Meeting prompts, hotkeys, and overlay code need no provider-specific changes. All request context belongs in `AgentRequest`; adapters must return trimmed answers and emit the full accumulated text.

Transcription follows the same Strategy, Adapter, and Factory patterns:

- `src/transcribe.ts` is the application facade backed by `TranscriptionService`.
- `src/transcription/types.ts` defines `TranscriptionProvider` (transcribe, dispose) and the optional `LiveTranscriptionSession` capability.
- `src/transcription/config.ts` resolves the selected provider, credentials, model, endpoint, and capture mode.
- `src/transcription/index.ts` creates the selected adapter lazily.
- `src/transcription/cloud.ts` implements the multipart protocol shared by OpenAI and Groq, with cancellation and a 60-second request timeout.
- `src/transcription/macos.ts` handles clip transcription through the native helper and owns the live session implemented in `src/live-session.ts`.
- `src/transcription/service.ts` owns adapter initialization, retries after creation failures, live-session operations, and disposal.

The application chooses continuous listening or clip capture from the configured capability, without naming a transcription provider. To add another transcription protocol, implement `TranscriptionProvider`, extend the configuration and factory, and optionally implement `createLiveSession` for continuous listening. Clip transcripts must be returned as trimmed text. Disposal must cancel pending work and stop any live session.

Run `npm test` for configuration, lifecycle, mocked agent streaming, and transcription adapter tests. Run `npm run build` for TypeScript, static assets, and native macOS helpers. Tests do not make paid API calls or launch native speech helpers.

## Limits

- Captures the system mix (other people on the call). Your headset mic usually is not included.
- Zoom/Meet may require an extra in-app recording permission.
- Transcribing a meeting may have consent implications (company policy / local law).

### Development app name on macOS

`npm run dev` and `npm start` use `scripts/run-app.cjs` to create a locally branded **Meeting Copilot.app** from the installed Electron runtime. The bundle has its own display name, executable name, identifier, icon, and ad-hoc development signature, so the Dock and macOS application menu show **Meeting Copilot**. The installed Electron dependency is left intact. Runtime bundles are cached under ignored `out/runtime/` directories and regenerated when Electron, the icon, or the launcher changes. `npm run prepare:app` prepares and verifies the bundle without launching it.

Changing `app.setName()` alone cannot change the operating system's app name ([Electron documentation](https://www.electronjs.org/docs/latest/api/app#appsetnamename)). Launch through the npm scripts rather than `electron .` to use the branded bundle.

#### To do

- In our settings, the "model" input should be a "select" component, with pre-defined agent IDs. This way the user does not need to know the ID of the agent.


The desktop workspace and floating widget use a charcoal interface based on the installed Cluely design and its official public references. The widget keeps the recording, Ask AI, region/full screenshot, show/hide, and stealth-restore shortcut hints. Its compact control row includes screen context, protection, mode, listening, and history; the **•••** menu holds workspace, modes/files, new chat, transcript, session ending, and hide controls. Protection remains best effort, as described above.


**History search:** The **Ask or search anything** field filters saved titles, notes, and transcripts. Press Enter to open the first current match. Use the **Ask “…”** action to ask AI about up to eight recent saved meetings, even when there are no literal search matches. The question panel below provides filtered questions and questions about the selected meeting. Notes, transcripts, Markdown exports, and editing remain in the meeting detail view. Calendar synchronization is not yet implemented.


The built-in Modes catalogue contains **General, Interview, Behavioral Interview, Coding Interview, System Design, Case Interview, Recruiter Screen, Sales, Recruiting, Team Meet, and Lecture**. Interview templates appear under **Looking for work**. Preview a template and select **Use this mode** to activate its detailed instructions immediately; changing instructions or file selection instead creates a custom mode through **Save and activate**. Template modes do not automatically include library documents. Shared Direct context notes still apply; attach the relevant files to a custom mode for document-specific assistance. Mode instructions also guide region and full-screen screenshot requests. Existing Meeting selections migrate to Team Meet, and existing Technical selections remain available for compatibility.


Model choices were reviewed against [OpenAI's current model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection) on 2026-11-26. GPT-6.2 Sol is the suggested starting point for general meeting assistance; GPT-6.1 Terra is a candidate for screenshot-heavy use, GPT-6 Luna for bounded low-cost questions, and GPT-6.2 Astra for demanding analysis. GPT-5.4 mini remains an efficient coding/vision option. Actual suitability and time to first response should be evaluated on your meetings; adding an option does not establish measured latency or access through your API account.

For these newly listed IDs, the OpenAI adapter sends explicit reasoning effort: `low` for Sol, Terra, and Luna; `medium` for Astra; `none` for GPT-5.4 mini. GPT-6.2 does not accept `none`. All these choices support streamed text and image input through the existing Chat Completions path; tools remain disabled. Existing models and custom IDs retain their prior request behavior. Your saved model and the default (`gpt-4.1-mini`) are preserved; select and save a newer option to switch. Speech transcription remains separately configured.


## Install as a normal local macOS app

Build a standalone app for the Mac you are using:

```bash
npm ci
npm run package:mac
```

On Apple Silicon the result is `release/mac-arm64/Meeting Copilot.app` (on an Intel Mac, `release/mac/Meeting Copilot.app`). Quit the development instance, drag the built app into Applications using Finder, and open it normally. The package includes Electron, the compiled application, its M icon, production dependencies, and the native audio/speech helpers. Running it does not require a terminal or a separate Node installation.

The `package:mac` command uses the installed Electron runtime and an ad-hoc signature for personal use on the build Mac, with hardened runtime disabled for that local signing configuration. It does not require an Apple Developer subscription. This script is for local installation; distributing to other Macs requires a separate Developer ID signing/notarization configuration.

The packaged app has the production bundle identifier `dev.gabrielocc.meeting-copilot`, distinct from the development runtime's `.dev` identifier. Approve any permissions requested by the packaged app. Configure API keys in its Settings if needed; `.env` is not embedded in the app. Re-run `npm run package:mac` after source changes and replace the installed app while it is closed.
