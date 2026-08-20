const card = document.getElementById("card");
const pill = document.getElementById("pill");
const text = document.getElementById("text");

const labels = {
  hidden: "Ready",
  recording: "Recording",
  transcribing: "Transcribing",
  thinking: "Thinking",
  answer: "Reply",
  error: "Error",
};

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
  if (state.status === "hidden") {
    card.classList.add("hidden");
    card.dataset.status = "hidden";
    text.textContent = "";
    return;
  }
  card.classList.remove("hidden");
  card.dataset.status = state.status;
  pill.textContent = labels[state.status] || state.status;
  text.textContent = state.text || "";
  fitWindow();
}

window.copilot.onState(render);

card?.addEventListener("click", () => {
  window.copilot.dismiss();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.copilot.dismiss();
  }
});
