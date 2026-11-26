(() => {
  let current;
  let working = false;
  const labels = { granted: "Allowed", denied: "Access denied · enable in System Settings", restricted: "Restricted by macOS", "not-determined": "Permission needed", unknown: "Could not verify access" };
  function renderPermissions(value) {
    if (!value) return;
    current = value;
    $("permission-onboarding").hidden = value.ready;
    $("workspace-shell").hidden = !value.ready;
    $("workspace-shell").inert = !value.ready;
    $("permission-speech-row").hidden = !value.required.includes("speech");
    for (const kind of ["screen", "microphone", "speech"]) {
      const granted = value[kind] === "granted";
      const button = $(`permission-${kind}`);
      $(`permission-${kind}-status`).textContent = labels[value[kind]] || labels.unknown;
      button.textContent = granted ? "✓ Allowed" : ["denied", "restricted"].includes(value[kind]) ? "Open Settings ↗" : "Allow access";
      button.disabled = granted || working || value.checking;
    }
    $("permission-refresh").disabled = working || value.checking;
    $("permission-continue").disabled = !value.granted || working || value.checking;
    $("onboarding-message").textContent = value.error || (working || value.checking ? "Checking macOS permissions…" : value.granted ? "You’re all set. Your copilot is ready." : "Approve each permission in macOS. Come back here and check again after changing access.");
  }
  async function run(operation) {
    working = true;
    if (current) renderPermissions(current);
    try { renderPermissions(await operation()); }
    catch (failure) {
      const message = failure.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
      if (current) current = { ...current, error: message };
      else $("onboarding-message").textContent = message;
    }
    finally { working = false; if (current) renderPermissions(current); }
  }
  document.querySelectorAll("[data-permission]").forEach(button => button.addEventListener("click", () => run(() => api.requestPermission(button.dataset.permission))));
  $("permission-refresh").addEventListener("click", () => run(() => api.permissions()));
  $("permission-continue").addEventListener("click", async () => {
    await run(async () => {
      const value = await api.completePermissions();
      if (value.ready) window.location.reload();
      return value;
    });
  });
  api.onState(next => renderPermissions(next.permissions));
  api.getState().then(next => renderPermissions(next.permissions)).catch(() => {
    $("onboarding-message").textContent = "Could not check permissions. Reopen Meeting Copilot to retry.";
  });
})();
