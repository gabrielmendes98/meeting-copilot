(() => {
  let meeting;
  let activeState;
  let modesState;
  let editingMode;
  let modeEditorVersion = 0;
  let searchVersion = 0;
  let meetingVersion = 0;
  let searchTimer;

  function error(error) { notify(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""), true); }

  function renderClock() {
    const startedAt = activeState?.sessionStartedAt;
    $("session-clock").hidden = !startedAt;
    if (!startedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    $("session-clock").textContent = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
  }

  let lastConversation = "";
  function renderWorkflows(next) {
    activeState = next;
    renderClock();
    $("chat-screen").checked = Boolean(next.useScreenContext);
    $("stop-chat").hidden = !next.chatActive;
    $("pause-session").hidden = !next.sessionStartedAt;
    $("pause-session").textContent = next.listening ? "Pause audio" : "End session";
    $("pause-session").dataset.action = next.listening ? "pause" : "end";
    for (const id of ["submit-chat", "clear-chat", "submit-history-question", "generate-notes", "save-meeting", "delete-meeting", "ask-this-meeting"]) $(id).disabled = next.busy;
    const turns = next.conversation || [];
    const signature = JSON.stringify(turns);
    if (signature === lastConversation) return;
    lastConversation = signature;
    $("conversation").hidden = !turns.length;
    $("conversation").replaceChildren(...turns.map(turn => {
      const row = document.createElement("li");
      const question = document.createElement("strong");
      const response = document.createElement("p");
      question.textContent = turn.question;
      response.textContent = turn.answer;
      row.append(question, response);
      return row;
    }));
  }

  $("ask-ai").addEventListener("submit", async event => {
    event.preventDefault();
    const input = $("chat-question");
    const original = input.value;
    const screen = $("chat-screen").checked;
    if (!original.trim() && !screen && !activeState?.sessionStartedAt) { input.focus(); return; }
    try {
      const completed = await api.ask(original, screen, false);
      if (completed && input.value === original) input.value = "";
    } catch (failure) { error(failure); }
  });
  $("chat-screen").addEventListener("change", () => api.setScreenContext($("chat-screen").checked).catch(error));
  $("stop-chat").addEventListener("click", () => api.cancelChat().catch(error));
  $("clear-chat").addEventListener("click", () => api.clearChat().catch(error));
  api.onNewChat(() => { $("chat-question").value = ""; });
  api.onAskShortcut(() => {
    showPage("meeting");
    $("ask-ai").requestSubmit();
  });
  api.onOpenPage(page => {
    showPage(page);
    if (page === "history") void loadMeetings();
  });

  function renderModes(value) {
    modesState = value;
    const select = $("meeting-mode");
    select.replaceChildren(...value.modes.map(mode => new Option(mode.title, mode.id)));
    select.value = value.selected;
    $("edit-mode").hidden = !isCustomMode(value.selected);
  }
  function isCustomMode(id) { return id.length === 36; }
  async function openModeEditor(mode) {
    const version = ++modeEditorVersion;
    const options = $("mode-reference-options");
    const all = $("mode-all-references");
    all.checked = mode?.referenceIds === undefined;
    options.hidden = all.checked;
    options.textContent = "Loading context documents…";
    const save = $("mode-editor").querySelector("button[type=submit]");
    save.disabled = true;
    editingMode = mode?.id ?? null;
    $("mode-name").value = mode?.title ?? "";
    $("mode-instructions").value = mode?.instructions ?? "";
    $("delete-mode").hidden = !mode;
    $("mode-editor").hidden = false;
    $("mode-name").focus();
    try {
      const files = (await api.listContext()).filter(file => file.available);
      if (version !== modeEditorVersion) return;
      const selected = new Set(mode?.referenceIds);
      options.replaceChildren(...files.map(file => {
        const label = document.createElement("label");
        label.className = "inline-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = file.id;
        input.checked = selected.has(file.id);
        label.append(input, document.createTextNode(file.name));
        return label;
      }));
      if (!files.length) options.textContent = "Add documents in the Context library to use them here.";
    } catch (failure) { if (version === modeEditorVersion) error(failure); }
    finally { if (version === modeEditorVersion) save.disabled = false; }
  }
  $("meeting-mode").addEventListener("change", async () => {
    try { renderModes(await api.updateMode("choose", $("meeting-mode").value)); }
    catch (failure) { if (modesState) renderModes(modesState); error(failure); }
  });
  $("mode-all-references").addEventListener("change", () => {
    $("mode-reference-options").hidden = $("mode-all-references").checked;
  });
  $("new-mode").addEventListener("click", () => openModeEditor());
  $("edit-mode").addEventListener("click", () => openModeEditor(modesState.modes.find(mode => mode.id === modesState.selected)));
  $("cancel-mode").addEventListener("click", () => { $("mode-editor").hidden = true; });
  $("mode-editor").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const references = $("mode-all-references").checked ? null
        : Array.from($("mode-reference-options").querySelectorAll("input:checked"), input => input.value);
      renderModes(await api.updateMode("save", editingMode, $("mode-name").value, $("mode-instructions").value, references));
      $("mode-editor").hidden = true;
    } catch (failure) { error(failure); }
  });
  $("delete-mode").addEventListener("click", async () => {
    if (!window.confirm("Delete this custom mode?")) return;
    try { renderModes(await api.updateMode("delete", editingMode)); $("mode-editor").hidden = true; }
    catch (failure) { error(failure); }
  });

  async function loadMeetings() {
    const version = ++searchVersion;
    try {
      const items = await api.listMeetings($("meeting-search").value);
      if (version !== searchVersion) return;
      const rows = items.map(item => {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-item";
        button.textContent = item.title;
        button.addEventListener("click", async () => {
          const version = ++meetingVersion;
          try {
            const result = await api.getMeeting(item.id);
            if (version === meetingVersion) openMeeting(result);
          } catch (failure) { error(failure); }
        });
        const detail = document.createElement("span");
        detail.textContent = new Date(item.startedAt).toLocaleString() + (item.hasNotes ? " · Notes" : " · Transcript");
        row.append(button, detail);
        return row;
      });
      if (!rows.length) {
        const empty = document.createElement("li");
        empty.textContent = $("meeting-search").value ? "No matching meetings." : "Completed recordings with speech will appear here.";
        rows.push(empty);
      }
      $("meeting-list").replaceChildren(...rows);
    } catch (failure) { error(failure); }
  }

  function openMeeting(value) {
    meeting = value;
    $("meeting-title").value = value.title;
    $("meeting-notes").value = value.notes;
    $("meeting-transcript").textContent = value.transcript;
    $("meeting-detail").hidden = false;
  }

  function refreshMeeting(updated, original) {
    if (meeting?.id === original.id) openMeeting(updated);
    void loadMeetings();
  }

  $("meeting-search").addEventListener("input", () => {
    searchVersion += 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMeetings, 160);
  });
  document.querySelector("[data-page='history']").addEventListener("click", loadMeetings);
  $("meeting-detail").addEventListener("submit", async event => {
    event.preventDefault();
    const original = meeting;
    try { refreshMeeting(await api.editMeeting(original.id, $("meeting-title").value, $("meeting-notes").value), original); }
    catch (failure) { error(failure); }
  });
  $("generate-notes").addEventListener("click", async () => {
    const original = meeting;
    if ($("meeting-notes").value && !window.confirm("Replace these notes with a new AI summary?")) return;
    try { refreshMeeting(await api.generateNotes(original.id), original); }
    catch (failure) { error(failure); }
  });
  $("export-meeting").addEventListener("click", async () => {
    try { if (await api.exportMeeting(meeting.id)) notify("Meeting exported."); }
    catch (failure) { error(failure); }
  });
  $("copy-meeting").addEventListener("click", async () => {
    try { await api.exportMeeting(meeting.id, true); notify("Meeting copied as Markdown."); }
    catch (failure) { error(failure); }
  });
  $("copy-meeting-transcript").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(meeting.transcript); notify("Transcript copied."); }
    catch (failure) { error(failure); }
  });
  $("delete-meeting").addEventListener("click", async () => {
    const original = meeting;
    if (!window.confirm("Delete this transcript and its notes from Meeting Copilot?")) return;
    try {
      await api.deleteMeeting(original.id);
      if (meeting?.id === original.id) { $("meeting-detail").hidden = true; meeting = undefined; }
      void loadMeetings();
    } catch (failure) { error(failure); }
  });

  async function askHistory(id) {
    const input = $("history-question");
    if (!input.value.trim()) { input.focus(); return; }
    const output = $("history-answer");
    output.hidden = false;
    output.textContent = "Thinking…";
    try { output.textContent = await api.askHistory(id, input.value, $("meeting-search").value) || "The provider returned no answer."; }
    catch (failure) { output.hidden = true; error(failure); }
  }
  $("ask-history").addEventListener("submit", event => { event.preventDefault(); void askHistory(null); });
  $("ask-this-meeting").addEventListener("click", () => void askHistory(meeting.id));

  api.onHistoryChanged(loadMeetings);
  api.onState(renderWorkflows);
  async function checkPermissions() {
    try {
      const status = await api.permissions();
      $("permission-status").hidden = false;
      $("permission-status").textContent = status
        ? `Screen recording: ${status.screen}. Microphone: ${status.microphone}. Manage access in System Settings → Privacy & Security. Local transcription requests Speech Recognition on first use.`
        : "Permission checks are available on macOS.";
      $("allow-microphone").hidden = status?.microphone !== "not-determined";
    } catch (failure) { error(failure); }
  }
  $("check-permissions").addEventListener("click", checkPermissions);
  $("allow-microphone").addEventListener("click", async () => {
    try { await api.requestMicrophone(); await checkPermissions(); } catch (failure) { error(failure); }
  });

  api.getState().then(renderWorkflows).catch(error);
  api.onModeChanged(renderModes);
  api.listModes().then(renderModes).catch(error);
  setInterval(renderClock, 1000);
})();
