import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { settingDefaults, secretKeys, shortcutKeys, legacyShortcutDefaults, type SettingsInput } from "./settings-config";

function settingsPath(): string { return path.join(app.getPath("userData"), "settings.json"); }

export function loadSettings(): void {
  const stored = fs.existsSync(settingsPath()) ? JSON.parse(fs.readFileSync(settingsPath(), "utf8")) : {};
  const loaded: Record<string, string> = {};
  for (const key of Object.keys(settingDefaults)) {
    if (typeof stored[key] === "string") loaded[key] = stored[key];
  }
  for (const key of secretKeys) {
    if (typeof stored[key] === "string") {
      loaded[key] = safeStorage.decryptString(Buffer.from(stored[key], "base64"));
    }
  }
  if (stored.shortcutVersion !== "2") {
    for (const key of shortcutKeys) {
      const fallback = legacyShortcutDefaults[key];
      if (fallback && (loaded[key] ?? process.env[key])?.trim().toLowerCase() === fallback.toLowerCase()) {
        loaded[key] = settingDefaults[key];
      }
    }
  }
  Object.assign(process.env, loaded);
}

export function publicSettings() {
  const values = Object.fromEntries(Object.entries(settingDefaults).map(([key, fallback]) => [key, shortcutKeys.some(shortcut => shortcut === key) ? process.env[key]?.trim() ?? fallback : process.env[key]?.trim() || fallback]));
  values.AGENT_PROVIDER = values.AGENT_PROVIDER.toLowerCase();
  values.STT_PROVIDER = values.STT_PROVIDER.toLowerCase();
  if (["speech", "local"].includes(values.STT_PROVIDER)) values.STT_PROVIDER = "macos";
  if (!process.env.AGENT_MODEL?.trim() && values.AGENT_PROVIDER === "cursor") values.AGENT_MODEL = "composer-2.5";
  return {
    values,
    shortcutDefaults: Object.fromEntries(shortcutKeys.map(key => [key, settingDefaults[key]])),
    hasAgentKey: Boolean(process.env.AGENT_API_KEY?.trim()),
    hasTranscriptionKey: Boolean(process.env.STT_PROVIDER_API_KEY?.trim()),
  };
}

export function saveSettings(input: SettingsInput): void {
  const stored: Record<string, string> = { ...input, shortcutVersion: "2" };
  for (const key of secretKeys) {
    const value = input[key] || process.env[key]?.trim();
    delete stored[key];
    if (value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS credential encryption is unavailable. Settings were not saved.");
      stored[key] = safeStorage.encryptString(value).toString("base64");
    }
  }
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const temp = `${settingsPath()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsPath());
  for (const [key, value] of Object.entries(input)) process.env[key] = value;
}
