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
| Custom AI instructions (listed in the installed free plan); mode reference files | Built-in templates can be customized as new modes, with instructions and selected reference files. PDF, DOCX, PPTX and common UTF-8 code/text imports retain the application's size limits. |
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


### 2026-11-26 installed-app audit and customization improvements

Inspected Cluely (New) 2.1.30 through its native UI, on the existing free account. Billing lists unlimited AI responses, unlimited audio sessions, access to newest AI models, and priority support for Pro. The additional undetectability tier advertises screen-share and recording exclusion. The free-plan list includes asking about past meetings and custom AI instructions; mode customization should therefore not be described as a verified paid-only feature. No purchase or paid entitlement was exercised.

The Modes page exposes editable template instructions and reference files, including PowerPoint and code files. Template preview and activation are separate in Cluely. Meeting Copilot now offers **Customize mode** for every built-in template: it opens a new copy without changing the active mode, and **Save and activate** persists and selects that copy. Existing custom modes retain their identity and selected references. Built-ins remain immutable.

Added PowerPoint `.pptx` text extraction using the presentation's slide relationships to preserve actual deck order. Slide text is labeled by slide number; images and speaker notes are excluded. Imports retain the 20 MB input/expanded-XML cap and 120,000-character context cap, reject malformed XML and external/unresolved slide relationships, and use the existing local snapshot and mode-scoping flow. Common UTF-8 source-code and configuration extensions are also accepted.

Reviewed [REA's official README](https://github.com/morluto/rea): its CLI can analyze Electron directories and ASARs without a native decompiler. The initial temporary CLI fetch failed because sandbox DNS could not resolve registry.npmjs.org. No REA setup, agent configuration changes, binary patching, or entitlement changes were made. These customization gaps were established through UI observation and repository inspection, so implementation did not depend on REA.

Verification: the restored locked dependencies enabled a successful TypeScript compile and automated extraction checks covering slide order, text runs, line breaks, XML entities, malformed/empty decks, unsupported relationships, expanded-size/context limits, and binary source-code rejection. Renderer tests exercise template copies, activation on save, preservation of built-ins, and editing custom references. Earlier verification limitations above describe the previous smoke run, not this dependency-restored test run. Paid-model access, native capture latency, and screen-share exclusion across real conferencing tools remain unverified.

Final verification for this increment: **52/52 automated tests passed** with `npm test`; `npm run build` succeeded, including TypeScript, static assets, and both native Swift helpers. In a separate temporary desktop profile, verified the built-in General template opened with instructions, saved and activated a new custom mode, reopened with editing/deletion controls, and displayed the updated reference-format guidance. No paid AI requests were sent.


### 2026-11-26 interface, Modes library, and mandatory permission setup

Per the user's preference, the redesign targets the premium experience using official public references plus the installed build. [Cluely's plan comparison](https://cluely.com/pricing) describes expanded customization, latest-model access, and screen-share exclusion by tier; it does not establish a distinct premium-only visual layout. The installed account remains free, so a pixel-identical premium-only screen is not claimed. The observed charcoal widget, composer-first controls, subdued sidebar, split Modes view, instruction area, and reference-file drop zone inform the implementation. Overlay shortcut hints are deliberately retained.

The observed reference-file workflow is **Settings → Modes → Files**. Meeting Copilot now has a sidebar **Modes** page with template navigation, editable context, file imports within the editor, explicit activation, and the selected-mode indicator. Newly imported readable references are selected while draft instructions remain intact. Failed imports show a reason. The existing global Context library remains for shared notes and document management. This extends the previous implementation rather than replacing its local snapshot and file-scoping behavior.

First launch now gates the workspace and overlay behind actual Screen Recording and Microphone authorization; local transcription additionally requires the speech helper's own Speech Recognition authorization. A new status/request-only helper command checks or requests speech access without recording or downloading a model. Completion persists locally with private file permissions, but grants are rechecked: denied, restricted, unknown, missing-helper, and revoked access cannot be bypassed by the saved completion flag, ordinary IPC actions, or global/local hotkeys. Cloud transcription skips speech authorization. Setup provides native requests, matching System Settings links, refresh, restart guidance, and an explicit Continue step.

Verification: the real native setup screen showed Screen Recording allowed, Microphone and Speech Recognition not determined, and Continue disabled. No permission was granted by the agent. A separate renderer preview with synthetic state verified the redesigned workspace, split Modes view, compact widget, visible hotkey hints, and expanded secondary controls. Automated checks cover grants, denial, revocation, cloud/local switching, completion persistence, helper failure, renderer locking, and guarded main-process entry points.

Automatic approval review rejected opening the reference app's History because it might expose unrelated private meeting content. No alternative route to that content was used; the Modes reference library was established through the permitted Settings view. The user subsequently approved History inspection; the resolved audit is recorded below.

Final verification for the interface increment: **57/57 tests passed**; the full build, including both Swift helpers, succeeded with Swift/Clang module caches directed to a writable temporary directory. The synthetic preview was closed after review; the native app remains at the real permission setup screen for the user to approve access.


### 2026-11-26 approved History inspection

The user explicitly approved the previously blocked History inspection. Opened History through Cluely's widget and observed its loaded state: a single **Ask or search anything** composer, a Back action, an **Upcoming** section with calendar refresh/connection, an empty sessions area, and an **Open / New chat** shortcut footer. Entering the synthetic query `demo` displayed **Ask “demo”** and **No sessions match that search**. No AI question was submitted to Cluely, no calendar account was connected, and the temporary query was cleared before restoring the widget. This account has no sessions, so populated reference meeting details remain unverified.

Updated Meeting Copilot's History workspace with the observed combined search layout, explicit Ask-query action, matching-session rows, centered empty state, refresh, Enter-to-open-first-result, and a New chat shortcut footer. The Ask-query action searches semantically over up to eight recent saved meetings through the existing provider flow rather than requiring a literal search match. Advanced filtered/selected-meeting questions, notes, transcripts, editing, copy, and export remain available. Calendar connection/upcoming-event synchronization remains an outstanding backend integration and is not represented by a nonfunctional button.

Verification: **59/59 tests passed**, including new renderer coverage for semantic questions without literal matches, Enter during pending search, populated-record opening, new chat, stale search responses, and stale AI answers. Static assets were copied successfully. A synthetic native renderer preview verified populated History, the Ask-query/empty-results state, and the answer area; no real meeting records or paid API calls were used in that preview.


### 2026-11-26 M branding restoration and complete mode catalogue

Restored the original blue ribbon M asset in the sidebar, title header, permission setup, and floating widget. The existing Dock and tray artwork was retained.

Re-inspected every mode in Cluely Settings. The default catalogue now matches the reference's eleven modes and order: General; Interview; Behavioral Interview; Coding Interview; System Design; Case Interview; Recruiter Screen; Sales; Recruiting; Team Meet; Lecture. The six interview templates are grouped under **Looking for work**. Each non-General template now has substantial role-specific instructions reflecting the observed workflow, written for Meeting Copilot rather than reproducing Cluely's prompt text verbatim.

Previews include descriptions and a direct **Use this mode** action. Previewing does not switch the active mode; activation persists and updates the active indicator. Editing template instructions or choosing files hides direct activation so changes are applied through **Save and activate** as a custom mode. Empty custom instructions are allowed, falling back to the assistant's default behavior. Templates start with no document references, so switching templates does not include unrelated library documents; shared direct notes remain global. Existing custom modes and references are preserved. An old `meeting` selection resolves to Team Meet, and an existing Technical selection remains usable without adding Technical to the default catalogue.

Mode instructions now reach region and full-screen screenshot requests as well as contextual chat; screenshot formatting and image-selection rules remain intact. **61/61 automated tests passed**, including the full catalogue, grouped interview modes, selection persistence, legacy selections, direct activation, empty custom instructions, and screenshot mode propagation. The full TypeScript/static/native build passed. A synthetic native preview visibly verified the M icon, all eleven templates, detailed Coding Interview instructions, and direct activation with the Active indicator. No paid AI requests were made.

Follow-up startup verification found and fixed a timing bug: when native permission checks completed after the first renderer state, mode/context initialization had already returned early. The workspace now loads modes and context exactly once when permissions become ready. Added regression coverage; **62/62 tests passed**. Restarted the actual idle app and visibly verified General populated the meeting picker and all eleven templates appeared on the Modes page. The app was left on Modes for review.


### 2026-11-26 current OpenAI model choices

Reviewed official API model pages and the current model-selection guide. Added GPT-6.2 Sol, GPT-6.1 Terra, GPT-6 Luna, GPT-6.2 Astra, and GPT-5.4 mini to Settings, with task-specific descriptions and a higher-cost/longer-wait hint for Astra. The existing selected model, default, GPT-4.1/GPT-4o choices, Cursor choices, and custom model IDs are preserved. Recommendations are based on official model guidance rather than a benchmark of this app's meeting traffic.

The new models support text/image input, streaming, and the existing Chat Completions endpoint. Added explicit supported reasoning settings for live use: low for Sol/Terra/Luna, medium for Astra, none for GPT-5.4 mini. GPT-6.2's unsupported none setting is never sent. Tools remain disabled and transcription settings are independent.

Verification uses mocked streaming requests with transcript and screenshot inputs, checking model IDs, reasoning parameters, and unchanged legacy/custom requests. Renderer checks verify availability of all new choices, preservation of the current selection, provider switching, descriptions, and custom IDs. No paid API requests or model-latency benchmarks were performed.

Sources: [model selection](https://developers.openai.com/api/docs/guides/model-selection), [GPT-6.2 migration](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

Final model-list validation: **64/64 tests passed**, and the full TypeScript/static/Swift build succeeded. No saved provider/model preference was changed.
