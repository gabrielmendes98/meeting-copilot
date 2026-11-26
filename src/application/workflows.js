(() => {
  let meeting;
  let activeState;
  let modesState;
  let modesLoading = false;
  let editingMode;
  let previewMode;
  let modeEditorVersion = 0;
  let searchVersion = 0;
  let meetingVersion = 0;
  let searchTimer;
  let listedMeetings = [];
  let historyAnswerVersion = 0;

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
    $("history-ask-query").disabled = Boolean(next.busy);
    $("history-new-chat").disabled = Boolean(next.busy);
    $("history-new-chat-shortcut").textContent = typeof shortcut === "function" ? shortcut(next.settings?.values?.CLEAR_CHAT_HOTKEY) : "⌘ R";
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
    if (page === "modes" && modesState && $("mode-editor").hidden) void openModeEditor(modesState.modes.find(mode => mode.id === modesState.selected));
  });

  function renderModes(value) {
    modesState = value;
    const select = $("meeting-mode");
    select.replaceChildren(...value.modes.map(mode => new Option(mode.title, mode.id)));
    select.value = value.selected;
    $("edit-mode").hidden = false;
    $("edit-mode").textContent = isCustomMode(value.selected) ? "Edit mode" : "Customize mode";
    $("mode-active-label").textContent = `Using ${value.modes.find(mode => mode.id === value.selected)?.title || "General"}`;
    const rows = [];
    let group;
    for (const mode of value.modes) {
      if (mode.group && mode.group !== group) {
        const label = document.createElement("div"); label.className = "mode-group"; label.textContent = mode.group; rows.push(label);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode-option" + (mode.id === previewMode ? " previewing" : "") + (group && !mode.group ? " mode-group-end" : "");
      button.textContent = `${mode.icon || (mode.builtIn ? "▤" : "◈")}  ${mode.title}${mode.id === value.selected ? "  ✓" : ""}`;
      button.addEventListener("click", () => { showPage("modes"); void openModeEditor(mode); });
      rows.push(button);
      group = mode.group;
    }
    $("mode-list").replaceChildren(...rows);
    const preview = value.modes.find(mode => mode.id === previewMode);
    $("mode-use-template").disabled = preview?.id === value.selected;
    $("mode-use-template").textContent = preview?.id === value.selected ? "Active" : "Use this mode";
  }
  function isCustomMode(id) { return modesState.modes.some(mode => mode.id === id && mode.builtIn === false); }
  async function openModeEditor(mode) {
    const version = ++modeEditorVersion;
    previewMode = mode?.id;
    $("mode-preview-title").textContent = mode?.title || "New mode";
    $("mode-description").textContent = mode?.description || "Your instructions and reference files, tailored to the conversation.";
    $("mode-use-template").hidden = !mode?.builtIn;
    if (modesState) renderModes(modesState);
    const options = $("mode-reference-options");
    const all = $("mode-all-references");
    all.checked = Boolean(mode && !mode.builtIn && mode.referenceIds === undefined);
    options.hidden = all.checked;
    options.textContent = "Loading context documents…";
    $("mode-import-status").textContent = "";
    const save = $("mode-editor").querySelector("button[type=submit]");
    save.disabled = true;
    const custom = mode && isCustomMode(mode.id);
    editingMode = custom ? mode.id : null;
    $("mode-name").value = mode ? custom ? mode.title : `${mode.title.slice(0, 55)} copy` : "";
    $("mode-instructions").value = mode?.instructions ?? "";
    $("delete-mode").hidden = !custom;
    $("mode-editor-hint").textContent = mode && !custom
      ? "Use this mode as-is, or save your edited instructions and files as a custom mode."
      : "Instructions and selected documents guide AI responses while this mode is active.";
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
  $("mode-use-template").addEventListener("click", async () => {
    if (!previewMode) return;
    try { renderModes(await api.updateMode("choose", previewMode)); }
    catch (failure) { error(failure); }
  });
  function markModeEdited() { $("mode-use-template").hidden = true; }
  $("mode-name").addEventListener("input", markModeEdited);
  $("mode-instructions").addEventListener("input", markModeEdited);
  $("mode-reference-options").addEventListener("change", markModeEdited);
  $("mode-all-references").addEventListener("change", () => {
    markModeEdited();
    $("mode-reference-options").hidden = $("mode-all-references").checked;
  });
  function newMode() { showPage("modes"); return openModeEditor(); }
  $("new-mode").addEventListener("click", newMode);
  $("create-mode").addEventListener("click", newMode);
  $("edit-mode").addEventListener("click", () => { showPage("modes"); return openModeEditor(modesState.modes.find(mode => mode.id === modesState.selected)); });
  document.querySelector("[data-page='modes']").addEventListener("click", () => {
    if (modesState && $("mode-editor").hidden) void openModeEditor(modesState.modes.find(mode => mode.id === modesState.selected));
  });
  $("cancel-mode").addEventListener("click", () => { ++modeEditorVersion; $("mode-editor").hidden = true; });
  $("mode-add-files").addEventListener("click", async () => {
    const version = modeEditorVersion;
    markModeEdited();
    const button = $("mode-add-files");
    const save = $("mode-editor").querySelector("button[type=submit]");
    const selected = new Set(Array.from($("mode-reference-options").querySelectorAll("input:checked"), input => input.value));
    button.disabled = save.disabled = true;
    try {
      const previous = new Set((await api.listContext()).map(file => file.id));
      const files = await api.addContext();
      if (typeof renderFiles === "function") renderFiles(files);
      if (version !== modeEditorVersion) return;
      const imported = files.filter(file => !previous.has(file.id));
      const failures = imported.filter(file => !file.available);
      $("mode-import-status").textContent = failures.length
        ? failures.map(file => `${file.name}: ${file.error || "Could not read this file."}`).join(" ")
        : imported.length ? `${imported.length} reference file${imported.length === 1 ? "" : "s"} added. Save and activate to apply your selection.` : "No new files added.";
      const options = $("mode-reference-options");
      options.replaceChildren(...files.filter(file => file.available).map(file => {
        const label = document.createElement("label"); label.className = "inline-check";
        const input = document.createElement("input"); input.type = "checkbox"; input.value = file.id;
        input.checked = selected.has(file.id) || !previous.has(file.id);
        label.append(input, document.createTextNode(file.name));
        return label;
      }));
      if (!options.children.length) options.textContent = "No readable reference files yet.";
    } catch (failure) { error(failure); }
    finally { button.disabled = false; if (version === modeEditorVersion) save.disabled = false; }
  });
  $("mode-editor").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const references = $("mode-all-references").checked ? null
        : Array.from($("mode-reference-options").querySelectorAll("input:checked"), input => input.value);
      renderModes(await api.updateMode("save", editingMode, $("mode-name").value, $("mode-instructions").value, references));
      await openModeEditor(modesState.modes.find(mode => mode.id === modesState.selected));
    } catch (failure) { error(failure); }
  });
  $("delete-mode").addEventListener("click", async () => {
    if (!window.confirm("Delete this custom mode?")) return;
    try { renderModes(await api.updateMode("delete", editingMode)); $("mode-editor").hidden = true; }
    catch (failure) { error(failure); }
  });

  async function loadMeetings() {
    const version = ++searchVersion;
    const query = $("meeting-search").value;
    try {
      const items = await api.listMeetings(query);
      if (version !== searchVersion) return;
      listedMeetings = items;
      $("history-open-result").disabled = !items.length;
      $("history-results-status").hidden = true;
      const rows = items.map(item => {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-item";
        button.textContent = item.title;
        button.addEventListener("click", () => openHistoryItem(item));
        const detail = document.createElement("span");
        detail.textContent = new Date(item.startedAt).toLocaleString() + (item.hasNotes ? " · Notes" : " · Transcript");
        const duration = document.createElement("small");
        duration.className = "history-duration";
        duration.textContent = `${Math.max(1, Math.round((item.endedAt - item.startedAt) / 60_000))} min`;
        row.append(button, detail, duration);
        return row;
      });
      if (!rows.length) {
        const empty = document.createElement("li");
        empty.className = "history-empty";
        empty.textContent = query ? "No sessions match that search." : "No sessions yet. Completed meetings with speech will appear here.";
        rows.push(empty);
      }
      $("meeting-list").replaceChildren(...rows);
    } catch (failure) {
      if (version !== searchVersion) return;
      listedMeetings = [];
      $("history-open-result").disabled = true;
      $("history-results-status").hidden = false;
      $("history-results-status").textContent = "Could not load saved sessions. Refresh to try again.";
      error(failure);
    }
  }

  async function openHistoryItem(item) {
    const version = ++meetingVersion;
    try {
      const result = await api.getMeeting(item.id);
      if (version === meetingVersion) openMeeting(result);
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
    listedMeetings = [];
    $("history-open-result").disabled = true;
    const query = $("meeting-search").value.trim();
    $("history-ask-query").hidden = $("history-scope").hidden = !query;
    $("history-ask-query-label").textContent = `Ask “${query}”`;
    ++historyAnswerVersion;
    $("history-answer").hidden = true;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMeetings, 160);
  });
  document.querySelector("[data-page='history']").addEventListener("click", loadMeetings);
  $("history-refresh").addEventListener("click", loadMeetings);
  $("history-search-form").addEventListener("submit", event => {
    event.preventDefault();
    if (listedMeetings.length) void openHistoryItem(listedMeetings[0]);
  });
  $("history-ask-query").addEventListener("click", () => askHistory(null, "", $("meeting-search").value));
  $("history-new-chat").addEventListener("click", async () => {
    try { await api.clearChat(); showPage("meeting"); $("chat-question").focus(); }
    catch (failure) { error(failure); }
  });
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

  async function askHistory(id, filter = $("meeting-search").value, prompt = $("history-question").value || $("meeting-search").value) {
    const input = $("history-question");
    if (!prompt.trim()) { $("history-question-panel").open = true; input.focus(); return; }
    const version = ++historyAnswerVersion;
    const output = $("history-answer");
    output.hidden = false;
    output.textContent = "Thinking…";
    try {
      const answer = await api.askHistory(id, prompt, filter);
      if (version === historyAnswerVersion) output.textContent = answer || "The provider returned no answer.";
    } catch (failure) { if (version === historyAnswerVersion) { output.hidden = true; error(failure); } }
  }
  $("ask-history").addEventListener("submit", event => { event.preventDefault(); void askHistory(null); });
  $("ask-this-meeting").addEventListener("click", () => void askHistory(meeting.id));

  api.onHistoryChanged(loadMeetings);
  async function loadModesWhenReady(next) {
    if ((next.permissions && !next.permissions.ready) || modesState || modesLoading) return;
    modesLoading = true;
    try { renderModes(await api.listModes()); }
    catch (failure) { error(failure); }
    finally { modesLoading = false; }
  }
  api.onState(next => { renderWorkflows(next); if (next.permissions?.ready) void loadModesWhenReady(next); });
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
  api.getState().then(loadModesWhenReady).catch(error);
  setInterval(renderClock, 1000);
})();
