const card = document.getElementById("card");
const pill = document.getElementById("pill");
const text = document.getElementById("text");
const element = (id) => document.getElementById(id);
let session = {};
let stealthActive = false;
let transcriptVisible = false;
let modeOptions = "";

function macShortcut(accelerator) {
  const symbols = { alt: "⌥", option: "⌥", shift: "⇧", control: "⌃", ctrl: "⌃", command: "⌘", cmd: "⌘", commandorcontrol: "⌘", cmdorctrl: "⌘", space: "␣", return: "↩", enter: "↩", escape: "⎋", esc: "⎋", left: "←", right: "→", up: "↑", down: "↓", tab: "⇥", backspace: "⌫", delete: "⌦", plus: "+" };
  return accelerator.split("+").map(key => symbols[key.toLowerCase()] || key.toUpperCase()).join("");
}

const labels = {
  hidden: "Ready",
  idle: "Ready",
  recording: "Recording",
  transcribing: "Transcribing",
  thinking: "Thinking",
  answer: "Reply",
  error: "Error",
};

function showReply(value) {
  const next = value || "";
  if (text.dataset.source === next) return;
  const atBottom = text.scrollHeight - text.scrollTop - text.clientHeight < 32;
  const previous = text.scrollTop;
  text.dataset.source = next;
  try {
    if (!next) text.innerHTML = "";
    else if (typeof renderMarkdown === "function") text.innerHTML = renderMarkdown(next);
    else text.textContent = next;
  } catch {
    text.textContent = next;
  }
  text.scrollTop = atBottom ? text.scrollHeight : previous;
}

function fitWindow() {
  if (!card || card.classList.contains("hidden")) return;
  requestAnimationFrame(() => {
    const prev = card.style.maxHeight;
    card.style.maxHeight = "none";
    const height = Math.ceil(card.scrollHeight + 16);
    card.style.maxHeight = prev;
    window.copilot.resize(height);
  });
}

function render(state) {
  if (!card || !pill || !text) return;
  const opacity = Math.min(1, Math.max(0.3, state.opacity ?? 1));
  card.style.setProperty("--background-opacity", String(opacity));
  card.style.setProperty("--text-opacity", String(Math.min(1, opacity * 2)));
  if (state.status === "hidden") {
    card.classList.add("hidden");
    card.dataset.status = "hidden";
    text.innerHTML = "";
    delete text.dataset.source;
    return;
  }
  card.classList.remove("hidden");
  card.dataset.status = state.status;
  pill.textContent = state.label || labels[state.status] || state.status;
  showReply(state.text || "");
  const stealthControl = element("stealth-control");
  stealthControl.title = state.stealth ? "Exit stealth mode / restore application" : "Enter stealth mode";
  stealthControl.hidden = !state.shortcuts?.stealth;
  element("stealth-shortcut-label").textContent = state.stealth ? "Restore" : "Stealth";
  for (const [action, accelerator] of Object.entries(state.shortcuts || {})) {
    const key = document.getElementById(`shortcut-${action}`);
    if (key) { key.parentElement.hidden = !accelerator; key.textContent = macShortcut(accelerator); key.parentElement.setAttribute("aria-label", `${key.parentElement.title}: ${accelerator}`); }
  }
  stealthActive = Boolean(state.stealth);
  element("overlay-toolbar").hidden = stealthActive;
  element("overlay-ask").hidden = stealthActive;
  element("overlay-transcript").hidden = stealthActive || !transcriptVisible;
  element("overlay-improve-solution").hidden = stealthActive || state.status !== "answer" || !/```/.test(state.text || "");
  card.classList.toggle("click-through", stealthActive);
  fitWindow();
}

window.copilot.onState(render);
window.copilot.onScroll((distance) => { text?.scrollBy({ top: distance, behavior: "instant" }); });

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.copilot.dismiss();
  }
});

function updateOverlayClock() {
  const clock = element("overlay-clock");
  clock.hidden = !session.startedAt;
  if (!session.startedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
  clock.textContent = [Math.floor(elapsed / 60), elapsed % 60].map(value => String(value).padStart(2, "0")).join(":");
}

window.copilot.onSession((next) => {
  session = next;
  const select = element("overlay-mode");
  const signature = JSON.stringify(next.modes);
  if (signature !== modeOptions) {
    modeOptions = signature;
    select.replaceChildren(...(next.modes || []).map(mode => new Option(mode.title, mode.id)));
  }
  if (next.mode) select.value = next.mode;
  element("overlay-screen-share-protection").setAttribute("aria-pressed", String(Boolean(next.screenShareProtection)));
  element("overlay-include-screen").checked = Boolean(next.useScreenContext);
  updateOverlayClock();
  element("overlay-audio").textContent = next.listening ? "Pause audio" : next.startedAt ? "Resume audio" : "Listen";
  element("overlay-end").hidden = !next.startedAt;
  element("overlay-stop-chat").hidden = !next.chatActive;
  for (const id of ["overlay-audio", "overlay-end", "overlay-send", "overlay-new-chat", "overlay-improve-solution"]) element(id).disabled = Boolean(next.busy);
  const transcript = element("overlay-transcript");
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 32;
  transcript.textContent = next.transcript || "Recognized speech will appear here.";
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  if (transcriptVisible) fitWindow();
});
setInterval(updateOverlayClock, 1000);

async function overlayAction(action, question, screen) {
  try { return await window.copilot.action(action, question, screen) !== false; }
  catch (error) { showReply(error.message); fitWindow(); return false; }
}

for (const action of ["improve-solution", "dashboard", "audio", "end", "settings", "modes", "history", "new-chat", "screen-share-protection"]) {
  element(`overlay-${action}`).addEventListener("click", () => void overlayAction(action));
}
element("overlay-stop-chat").addEventListener("click", () => void overlayAction("stop-chat"));
element("overlay-hide").addEventListener("click", () => window.copilot.dismiss());
element("overlay-transcript-toggle").addEventListener("click", (event) => {
  transcriptVisible = !transcriptVisible;
  event.currentTarget.setAttribute("aria-pressed", String(transcriptVisible));
  element("overlay-transcript").hidden = stealthActive || !transcriptVisible;
  fitWindow();
});
element("overlay-ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element("overlay-question");
  const ask = input.value;
  const screen = element("overlay-include-screen").checked;
  if (!ask.trim() && !screen && !session.startedAt) { input.focus(); return; }
  if (await overlayAction("chat", ask, screen) && input.value === ask) input.value = "";
});

element("overlay-include-screen").addEventListener("change", () => {
  void overlayAction("screen-context", undefined, element("overlay-include-screen").checked);
});
window.copilot.onAskShortcut(() => element("overlay-ask").requestSubmit());
window.copilot.onFocusComposer(() => element("overlay-question").focus());
window.copilot.onNewChat(() => { element("overlay-question").value = ""; });

element("overlay-mode").addEventListener("change", async (event) => {
  const select = event.currentTarget;
  if (!(await overlayAction("mode", select.value))) select.value = session.mode;
});

element("overlay-more").addEventListener("toggle", fitWindow);
