const api = window.meetingCopilot;
const $ = (id) => document.getElementById(id);
const form = $("settings-form");
let state;
let saving = false;
let files = [];
let savedContextText = "";
let contextTextLoaded = false;
let savingContextText = false;
let noticeTimer;
function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, error ? 9000 : 4000);
}
function showPage(page) {
  document.querySelectorAll(".page").forEach((element) => { element.hidden = element.id !== `page-${page}`; });
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  document.querySelector("main").scrollTop = 0;
}
function shortcut(value) { return value.replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/gi, "⌘").replace(/Control|Ctrl/gi, "⌃").replace(/Option|Alt/gi, "⌥").replace(/Shift/gi, "⇧").replaceAll("+", " "); }
function populateSettings(settings) {
  for (const [key, value] of Object.entries(settings.values)) { if (form.elements[key]) form.elements[key].value = value; }
  form.elements.AGENT_API_KEY.value = "";
  form.elements.STT_PROVIDER_API_KEY.value = "";
  $("agent-key-hint").textContent = settings.hasAgentKey ? "A key is configured. Leave blank to keep it, or enter a replacement. Keys are saved encrypted on this Mac." : "Keys are saved encrypted on this Mac.";
  $("stt-key-hint").textContent = settings.hasTranscriptionKey ? "A key is configured. Leave blank to keep it, or enter a replacement." : "Use a key from your selected transcription provider.";
  updateSpeechField();
}
function updateSpeechField() { $("stt-key-field").hidden = form.elements.STT_PROVIDER.value === "macos"; }
function render(next) {
  state = next;
  const { listening, busy, live, overlay, settings } = next;
  document.body.classList.toggle("listening", listening);
  $("sidebar-dot").classList.toggle("listening", listening);
  $("sidebar-status").textContent = busy ? "Copilot is working" : listening ? (live ? "Listening to your meeting" : "Recording your meeting") : "Ready when you are";
  $("session-title").textContent = listening ? (live ? "Listening to the conversation" : "Recording a meeting clip") : "Ready for your next meeting";
  $("session-description").textContent = listening ? (live ? "Ask for help at any point. Listening continues." : "Choose an action to stop and transcribe this clip.") : "Capture the conversation from your meeting app.";
  $("capture").firstChild.textContent = listening ? (live ? "Stop listening " : "Stop recording ") : (live ? "Start listening " : "Start recording ");
  const shortcuts = { "record-shortcut": "HOTKEY", "answer-shortcut": "CHECKPOINT_HOTKEY", "summary-shortcut": "SUMMARY_HOTKEY", "notes-shortcut": "BRIEFING_HOTKEY", "screenshot-shortcut": "SCREENSHOT_HOTKEY" };
  for (const [id, key] of Object.entries(shortcuts)) $(id).textContent = shortcut(settings.values[key]);
  document.querySelectorAll("[data-action]").forEach((button) => {
    const action = button.dataset.action;
    button.disabled = busy || (["checkpoint", "summary", "briefing"].includes(action) && !listening);
  });
  $("configuration-banner").hidden = !next.configurationError;
  $("configuration-message").textContent = next.configurationError;
  const isError = overlay.status === "error";
  const text = isError ? overlay.text : busy && overlay.text ? overlay.text : next.latestReply;
  $("reply").textContent = text || "Start listening, then ask your copilot for an answer or summary.\nYour response will appear here and in the floating overlay.";
  $("reply").classList.toggle("empty", !text);
  $("reply-heading").textContent = isError ? "Something needs attention" : busy ? "Your copilot is working…" : "Your copilot’s response";
  $("copy-reply").disabled = !next.latestReply;
  $("save-settings").disabled = busy || listening || saving;
  $("save-hint").textContent = listening ? "Stop listening before saving settings." : busy ? "Wait for the current action to finish." : "Changes apply immediately after saving.";
}
function renderFiles(next) {
  files = next;
  $("context-count").textContent = String(files.length);
  $("context-empty").hidden = files.length > 0;
  $("context-list").replaceChildren();
  for (const file of files) {
    const row = document.createElement("li"); row.className = "file-row";
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = file.name.split(".").pop().toUpperCase();
    const info = document.createElement("div"); info.className = "file-info";
    const name = document.createElement("div"); name.className = "file-name"; name.textContent = file.name;
    const meta = document.createElement("div"); meta.className = "file-meta"; meta.textContent = `${file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KB`} · Added ${new Date(file.addedAt).toLocaleDateString()}`;
    info.append(name, meta);
    if (file.error) { meta.textContent = file.error; meta.classList.add("file-error"); }
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = file.available ? "Ready" : "Not included";
    const remove = document.createElement("button"); remove.className = "remove-file"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove ${file.name} from library`);
    remove.addEventListener("click", async () => { try { renderFiles(await api.removeContext(file.id)); } catch (error) { notify(error.message, true); } });
    row.append(icon, info, badge, remove); $("context-list").append(row);
  }
}
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll("[data-open-settings]").forEach((button) => button.addEventListener("click", () => showPage("settings")));
document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => { try { await api.action(button.dataset.action); } catch (error) { notify(error.message, true); } }));
$("copy-reply").addEventListener("click", async () => { try { await navigator.clipboard.writeText(state.latestReply); notify("Response copied."); } catch { notify("Could not copy the response.", true); } });
async function addFiles() {
  $("add-context").disabled = $("add-context-empty").disabled = true;
  $("add-context").textContent = "Importing…";
  try { renderFiles(await api.addContext()); } catch (error) { notify(error.message, true); }
  finally { $("add-context").disabled = $("add-context-empty").disabled = false; $("add-context").textContent = "＋ Add files"; }
}
$("add-context").addEventListener("click", addFiles);
$("add-context-empty").addEventListener("click", addFiles);
function updateContextTextStatus() {
  const dirty = $("context-text").value !== savedContextText;
  $("save-context-text").disabled = !contextTextLoaded || savingContextText || !dirty;
  $("context-text-hint").textContent = savingContextText ? "Saving…" : dirty ? "Unsaved changes. Save to use this text with your documents." : savedContextText.trim() ? "Saved text is included with your documents." : "Save text to include it with your documents.";
}
$("context-text").disabled = true;
$("context-text").addEventListener("input", updateContextTextStatus);
$("context-text-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!contextTextLoaded || savingContextText) return;
  savingContextText = true; updateContextTextStatus();
  try { savedContextText = await api.saveContextText($("context-text").value); notify(savedContextText.trim() ? "Context text saved." : "Context text cleared."); }
  catch (error) { notify(error.message, true); }
  finally { savingContextText = false; updateContextTextStatus(); }
});
form.elements.STT_PROVIDER.addEventListener("change", updateSpeechField);
form.elements.AGENT_PROVIDER.addEventListener("change", () => {
  const input = form.elements.AGENT_MODEL;
  if (["gpt-4.1-mini", "composer-2.5"].includes(input.value)) input.value = form.elements.AGENT_PROVIDER.value === "cursor" ? "composer-2.5" : "gpt-4.1-mini";
});
form.addEventListener("submit", async (event) => {
  event.preventDefault(); saving = true; $("save-settings").disabled = true;
  try { populateSettings(await api.saveSettings(Object.fromEntries(new FormData(form)))); notify("Settings saved. Your copilot is ready to use them."); }
  catch (error) { notify(error.message, true); }
  finally { saving = false; if (state) render(state); }
});
api.onState(render);
async function initialize() {
  try { const initial = await api.getState(); populateSettings(initial.settings); render(initial); }
  catch (error) { notify(error.message, true); }
  try { renderFiles(await api.listContext()); } catch (error) { notify(error.message, true); }
  try {
    savedContextText = await api.getContextText();
    $("context-text").value = savedContextText; contextTextLoaded = true; $("context-text").disabled = false;
    updateContextTextStatus();
  } catch (error) { $("context-text-hint").textContent = "Could not load saved text. Reopen the window to retry."; notify(error.message, true); }
}
initialize();
