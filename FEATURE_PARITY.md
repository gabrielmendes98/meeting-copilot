# Cluely feature parity

## Reference behavior

The installed Cluely (New) 2.1.30 build was inspected on a free account after onboarding. The widget exposes a screen-context toggle, chat and follow-up input, a mode picker, Listen, History, and Settings. With screen context off, a synthetic arithmetic question returned 51 and a follow-up using the previous result returned 53. The chat exposes Stop response while generating and Copy response after completion. History surfaces a calendar connection when no calendar is connected. Settings include separate transcription and output languages, microphone source and test, login launch, meeting reminders, and the free session quota.

The installed build uses Cmd–Backslash for visibility, Cmd–Enter for asking about screen or audio, Cmd–R for a new chat, Cmd–Comma for settings, Shift–Cmd–Backslash for session start or stop, Cmd–Arrow for movement, and Shift–Cmd–Up or Down for scrolling. Its shortcut editor can rebind, clear, or reset individual actions. The public interactive demo advertises Cmd–Backslash for screen help. The installed version is the reference for Meeting Copilot’s new defaults. It uses the unified Ask AI flow for live context. The older Live Insights guide describes canned actions. Meeting Copilot migrated the previous default shortcuts and retained custom bindings.

- [Current interactive demo](https://new.cluely.com/) and [desktop download](https://cluely.com/download)
- [Documentation index](https://docs.cluely.com/llms.txt), [live workflows](https://docs.cluely.com/feature/liveinsights), [settings](https://docs.cluely.com/feature/settings), [changelog](https://docs.cluely.com/changelog)
- [Audio troubleshooting](https://docs.cluely.com/debugging/audio), [meeting notes](https://docs.cluely.com/feature/postcall), [pre-call briefs](https://docs.cluely.com/feature/precall), [coaching](https://docs.cluely.com/feature/coaching), [calendar troubleshooting](https://docs.cluely.com/debugging/calendar)
- [Customization suite](https://docs.cluely.com/enterprise/customizationsuite), [knowledge base](https://docs.cluely.com/enterprise/knowledgebase), [integrations](https://docs.cluely.com/enterprise/integrations), [directory sync](https://docs.cluely.com/enterprise/directorysync), [roles](https://docs.cluely.com/enterprise/rolemanagement)
- [Mobile](https://cluely.com/mobile), [App Store](https://apps.apple.com/br/app/cluely-ai-notetaker/id6755442775), [plans](https://cluely.com/pricing)

## Desktop paid-tier coverage

| Cluely entitlement | Meeting Copilot coverage |
| --- | --- |
| Pro removes app quotas on responses and sessions | The existing BYOK architecture has no app-imposed response or session quotas. Provider limits and charges still apply. |
| Pro gives access to newer models | Settings accept a provider model ID in addition to the built-in choices. Compatibility depends on the model and the provider account. Live verification remains pending. |
| Pro expands instruction and file customization | Custom modes support instructions and selected reference files. Imports retain the application's text and file-size limits. |
| Pro includes priority support | Hosted support and billing remain open. |
| Pro + Undetectability adds screen-share and recording exclusion | Meeting Copilot has Electron's best-effort window protection. Coverage across screen-sharing tools and capture methods remains unverified. |

## Checklist

A checked row requires verification against its acceptance criteria. Automated, native, and live-provider verification are recorded separately.

| Done | Workflow and expected behavior | Baseline gap and work required | Acceptance and verification |
| --- | --- | --- | --- |
| [ ] | Start, pause, resume, and end an audio session, from dashboard, shortcuts, or overlay | Capture toggle conflates recording and session lifetime. Flush the final speech, preserve prior segments after pause, show duration, and allow screen-only assistance. | Automated IPC checks cover pause, resume, final flush, and one saved transcript. Actual microphone and system capture are pending. |
| [ ] | Capture meeting output and local microphone, independently | ScreenCaptureKit system audio only. Add opt-in microphone capture and source-aware timing. | Loopback and microphone independently work, mixed speech remains intelligible, denied permission has a recovery path. |
| [ ] | Live transcript | SpeechAnalyzer rotates local audio. Cloud takes one clip and stops during an action. Provide continuing updates for each engine. | Both native helpers compile. Cloud upload request formatting, aborts, and transcript persistence have automated coverage. Native live capture and latency are pending. |
| [ ] | Native permissions and onboarding | Settings show missing keys. Native requests happen during capture. Add actionable audio, screen and speech diagnostics. | The desktop smoke run displayed Screen Recording denied and Microphone not determined in the separate test profile. Grant and recovery flows are pending. |
| [ ] | Typed and follow-up questions with screen, audio and documents | Separate screenshot and transcript prompts, no user chat. Mix explicit inputs and bounded history, stream replies. | Cluely follow-ups verified live. Meeting Copilot tests verify prior turns, selected context, stream cancellation, and missing-key recovery. Live provider and screenshot input remain pending. |
| [ ] | Promptless screen help | Region and primary-screen questions already exist. Add assistance that can describe or interpret context without a visible question. | Screen-only help works without starting audio and excludes the app’s own windows from its input. |
| [x] | Unified live Ask AI controls | Removed legacy canned actions, suggestion buttons, and their hotkeys. Use a single question box with audio and optional screen context. | Verified the updated workspace on macOS and confirmed the removed IPC actions are rejected. |
| [ ] | Built-in and custom modes, mode switching, Smart Mode | Global document library only. Add saved instructions and a mode selector in live workflows. | Desktop smoke verified create, activate, reopen after restart, and select one reference document. Tests cover document scoping and request construction. |
| [ ] | Live overlay, hide independently, open dashboard, move across screens, transcript/control access | Floating reply and global movement already exist; limited overlay controls. | Keyboard and mouse controls work on supported displays without ending audio. |
| [ ] | Custom shortcuts, clear AI context, display selection, auto-launch | Existing customizable keybindings and opacity. Add chat/reset and OS settings. | Conflicts roll back, reset clears the conversation, selected display and login preference persist. |
| [ ] | Meeting and output languages | Both fixed to English for audio flows. Wire independent language preferences to prompts and provider configuration. | Change spoken and response languages independently. |
| [ ] | Screen sharing privacy | Existing best-effort Electron content protection and local click-through. macOS ScreenCaptureKit may still include protected windows. | Verify independently across actual sharing modes; universal exclusion requires capabilities beyond the observed Electron setup. |
| [ ] | Searchable meeting history, titles, notes and transcript | Transcript held in memory, no history or post-call jobs. Add local durable records, generated notes, search and editing. | Desktop smoke verified reopening, transcript search, opening a result, and editing notes. Automated tests cover persistence, deletion, and retention after provider failure. |
| [ ] | Export, share, follow-up drafts and ask about past meetings | Clipboard actions only, no stored sessions. Export Markdown/transcript, ground history chat, support drafts. | Automated coverage verifies selected-meeting question context and Markdown generation. Live AI and the save dialog remain pending. Link sharing needs accounts and hosted storage. |
| [ ] | Meeting detection, upcoming calendar/alerts, auto-stop, pre-call brief | No calendar or lifecycle integrations. Calendar requires EventKit or consented OAuth and native meeting lifecycle signals. | Calendar events appear, alerts can start or end a meeting, agenda and attendees ground the prep brief. |
| [ ] | Coaching, scoring, missed opportunities, team reporting | No scorecards or reporting. Needs reusable rubrics and hosted team aggregation. | Rubric evidence is grounded in transcript and organizational access is enforced. |
| [ ] | Reference library, document extraction, organization knowledge | Local PDF/DOCX/text formats and direct notes exist. Organization sync, prompt assignment and semantic retrieval absent. | Files survive restart and apply to requests. Organization knowledge and scoped visibility require a backend. |
| [ ] | Team administration, SSO/directory sync, CRM/ATS integrations, provisioning | No accounts, tenant model or connectors. Requires a backend, integration credentials and test tenants. | Authorized tenant users can sync contacts, provision roles and write approved meeting outcomes. |
| [ ] | Windows, iOS, online sync and desktop/mobile continuity | macOS Swift helpers and desktop Electron UI only. Requires Windows capture, an iOS client and authenticated sync. | Exercise platform permissions, record online/offline, verify conflict handling and isolated accounts. |
| [ ] | Billing, model entitlements and online support | BYOK providers and local app with no billing. Cluely documents separate desktop/mobile subscriptions and quota tiers. | Verified purchases, renewals and limits require an owned billing backend and test accounts. |

## Working notes

The repository is macOS-first. The product retains its own workspace and overlay design. Keep transcript files local by default and use the selected AI provider for explicit assistance and generated meeting notes. A macOS app launch and provider calls are separate verification gates.


### macOS smoke run

Both Swift helpers compiled. The repository renderer and main process ran on the cached Electron 41.7.1 distribution with a separate temporary user-data profile and synthetic context and history. Verified workspace launch, settings population, mode persistence, reference selection, transcript search, and saving an edited note. Full npm dependency installation is blocked by DNS resolution for registry.npmjs.org. Cached TypeScript can emit the application, but the normal build and strict type check need the locked dependencies. The emitted JavaScript suite passed 35 of 38 checks. Two document tests require the missing PDF and DOCX dependencies, and the provider test file requires the missing OpenAI SDK. Live provider answers require a configured key, and native audio and screen capture require permissions for the running app identity.


### Shortcut and live-control alignment

The installed widget exposes Ask AI, screen context, modes, Listen, History, and Settings. Meeting Copilot added the mode picker and navigation to its overlay. Cmd–R cleared a synthetic draft, Cmd–Enter submitted it to the missing-key guard, and Cmd–Comma opened Settings in the macOS smoke build. The shortcut defaults and foreground dispatch for Cmd–Backslash have automated coverage. Out-of-focus shortcut delivery and native capture still require a separate live check.
