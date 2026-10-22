const card = document.getElementById("card");
const pill = document.getElementById("pill");
const text = document.getElementById("text");

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
  for (const [action, accelerator] of Object.entries(state.shortcuts || {})) {
    const key = document.getElementById(`shortcut-${action}`);
    if (key) { key.textContent = macShortcut(accelerator); key.parentElement.setAttribute("aria-label", `${key.parentElement.title}: ${accelerator}`); }
  }
  document.getElementById("stealth-control").hidden = !state.stealth;
  card.classList.toggle("click-through", Boolean(state.stealth));
  fitWindow();
}

window.copilot.onState(render);
window.copilot.onScroll((distance) => { text?.scrollBy({ top: distance, behavior: "instant" }); });

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.copilot.dismiss();
  }
});
