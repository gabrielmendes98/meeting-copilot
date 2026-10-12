export const settingDefaults = {
  AGENT_PROVIDER: "openai", AGENT_MODEL: "gpt-4.1-mini",
  STT_PROVIDER: "auto", HOTKEY: "Alt+Space", CHECKPOINT_HOTKEY: "Alt+1",
  SUMMARY_HOTKEY: "Alt+2", BRIEFING_HOTKEY: "Alt+3", SCREENSHOT_HOTKEY: "Alt+Shift+Space",
  STEALTH_HOTKEY: "Alt+Shift+S",
};
export const secretKeys = ["AGENT_API_KEY", "STT_PROVIDER_API_KEY"] as const;
export const shortcutKeys = ["HOTKEY", "CHECKPOINT_HOTKEY", "SUMMARY_HOTKEY", "BRIEFING_HOTKEY", "SCREENSHOT_HOTKEY", "STEALTH_HOTKEY"] as const;
export type Settings = typeof settingDefaults;
export type SettingsInput = Settings & { AGENT_API_KEY?: string; STT_PROVIDER_API_KEY?: string };

export function validateSettings(input: unknown): SettingsInput {
  if (!input || typeof input !== "object") throw new Error("Invalid settings.");
  const source = input as Record<string, unknown>;
  const result = {} as Record<string, string>;
  for (const key of Object.keys(settingDefaults)) {
    if (typeof source[key] !== "string" || !(source[key] as string).trim()) throw new Error(`Enter a value for ${key}.`);
    result[key] = (source[key] as string).trim();
    if (result[key].length > 200) throw new Error(`${key} is too long.`);
  }
  if (!["openai", "cursor"].includes(result.AGENT_PROVIDER)) throw new Error("Choose a supported agent provider.");
  if (!["auto", "macos", "openai", "groq"].includes(result.STT_PROVIDER)) throw new Error("Choose a supported transcription provider.");
  const shortcuts = shortcutKeys.map((key) => result[key].toLowerCase().replace(/option/g, "alt").replace(/commandorcontrol/g, "cmdorctrl").replace(/command/g, "cmd").replace(/control/g, "ctrl"));
  if (new Set(shortcuts).size !== shortcuts.length) throw new Error("Each action needs a different shortcut.");
  for (const key of secretKeys) {
    if (source[key] !== undefined && typeof source[key] !== "string") throw new Error("Invalid API key.");
    if (typeof source[key] === "string" && source[key].trim()) result[key] = source[key].trim();
  }
  return result as SettingsInput;
}
