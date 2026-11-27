export const meetingLanguages = {
  "en-US": "English", "pt-BR": "Portuguese (Brazil)", "es-ES": "Spanish", "fr-FR": "French",
  "de-DE": "German", "it-IT": "Italian", "ja-JP": "Japanese", "ko-KR": "Korean", "zh-CN": "Mandarin Chinese",
} as const;

export function outputLanguage(): string {
  const locale = process.env.OUTPUT_LANGUAGE as keyof typeof meetingLanguages;
  return meetingLanguages[locale] || meetingLanguages["en-US"];
}

export const settingDefaults = {
  AGENT_PROVIDER: "openai", AGENT_MODEL: "gpt-4.1-mini",
  OVERLAY_OPACITY: "100",
  MEETING_AUDIO_LANGUAGE: "en-US", OUTPUT_LANGUAGE: "en-US", AUDIO_SOURCE: "system",
  AUTO_ANSWER: "off", OVERLAY_DISPLAY: "primary", AUTO_LAUNCH: "off",
  STT_PROVIDER: "auto", HOTKEY: "CommandOrControl+Shift+\\",
  SCREENSHOT_HOTKEY: "Alt+Shift+Space", FULL_SCREENSHOT_HOTKEY: "Alt+Ctrl+Space",
  STEALTH_HOTKEY: "Alt+Shift+S", OVERLAY_TOGGLE_HOTKEY: "CommandOrControl+\\",
  OVERLAY_LEFT_HOTKEY: "CommandOrControl+Left", OVERLAY_RIGHT_HOTKEY: "CommandOrControl+Right",
  OVERLAY_UP_HOTKEY: "CommandOrControl+Up", OVERLAY_DOWN_HOTKEY: "CommandOrControl+Down",
  OVERLAY_SCROLL_UP_HOTKEY: "CommandOrControl+Shift+Up", OVERLAY_SCROLL_DOWN_HOTKEY: "CommandOrControl+Shift+Down",
  OVERLAY_OPACITY_DOWN_HOTKEY: "Alt+Shift+-", OVERLAY_OPACITY_UP_HOTKEY: "Alt+Shift+=",
  OVERLAY_RESET_HOTKEY: "Alt+Shift+0", SCREEN_ASSIST_HOTKEY: "CommandOrControl+Enter",
  IMPROVE_SOLUTION_HOTKEY: "Alt+Shift+I", CLEAR_CHAT_HOTKEY: "CommandOrControl+R", SETTINGS_HOTKEY: "CommandOrControl+,",
};
export const secretKeys = ["AGENT_API_KEY", "STT_PROVIDER_API_KEY"] as const;
export const shortcutKeys = ["HOTKEY", "SCREENSHOT_HOTKEY", "FULL_SCREENSHOT_HOTKEY", "STEALTH_HOTKEY", "OVERLAY_TOGGLE_HOTKEY", "OVERLAY_LEFT_HOTKEY", "OVERLAY_RIGHT_HOTKEY", "OVERLAY_UP_HOTKEY", "OVERLAY_DOWN_HOTKEY", "OVERLAY_SCROLL_UP_HOTKEY", "OVERLAY_SCROLL_DOWN_HOTKEY", "OVERLAY_OPACITY_DOWN_HOTKEY", "OVERLAY_OPACITY_UP_HOTKEY", "OVERLAY_RESET_HOTKEY", "SCREEN_ASSIST_HOTKEY", "IMPROVE_SOLUTION_HOTKEY", "CLEAR_CHAT_HOTKEY", "SETTINGS_HOTKEY"] as const;
const optionalShortcuts = new Set<string>(shortcutKeys.filter((key) => key !== "STEALTH_HOTKEY"));
export const legacyShortcutDefaults: Partial<Record<typeof shortcutKeys[number], string>> = {
  HOTKEY: "Alt+Space", OVERLAY_TOGGLE_HOTKEY: "Alt+Shift+B",
  OVERLAY_LEFT_HOTKEY: "Alt+Shift+Left", OVERLAY_RIGHT_HOTKEY: "Alt+Shift+Right",
  OVERLAY_UP_HOTKEY: "Alt+Shift+Up", OVERLAY_DOWN_HOTKEY: "Alt+Shift+Down",
  OVERLAY_SCROLL_UP_HOTKEY: "Alt+Control+Up", OVERLAY_SCROLL_DOWN_HOTKEY: "Alt+Control+Down",
  SCREEN_ASSIST_HOTKEY: "CommandOrControl+Shift+Enter", CLEAR_CHAT_HOTKEY: "Alt+Shift+Backspace",
};
export type Settings = typeof settingDefaults;
export type SettingsInput = Settings & { AGENT_API_KEY?: string; STT_PROVIDER_API_KEY?: string };

export function normalizeShortcut(value: string, platform = process.platform): string {
  const tokens = value.toLowerCase().split("+").map((token) => token.trim());
  const key = tokens.pop() || "";
  const modifiers = tokens.map((token) => {
    if (["commandorcontrol", "cmdorctrl"].includes(token)) return platform === "darwin" ? "cmd" : "ctrl";
    if (token === "command") return "cmd";
    if (token === "option") return "alt";
    if (token === "control") return "ctrl";
    return token;
  });
  const normalizedKey = ({ return: "enter", esc: "escape", backslash: "\\", comma: "," } as Record<string, string>)[key] || key;
  return [...modifiers.sort(), normalizedKey].join("+");
}

export function validateSettings(input: unknown): SettingsInput {
  if (!input || typeof input !== "object") throw new Error("Invalid settings.");
  const source = input as Record<string, unknown>;
  const result = {} as Record<string, string>;
  for (const key of Object.keys(settingDefaults)) {
    if (typeof source[key] !== "string" || (!optionalShortcuts.has(key) && !(source[key] as string).trim())) throw new Error(`Enter a value for ${key}.`);
    result[key] = (source[key] as string).trim();
    if (result[key].length > 200) throw new Error(`${key} is too long.`);
  }
  if (!["openai", "cursor"].includes(result.AGENT_PROVIDER)) throw new Error("Choose a supported agent provider.");
  if (!["auto", "macos", "openai", "groq"].includes(result.STT_PROVIDER)) throw new Error("Choose a supported transcription provider.");
  for (const key of ["MEETING_AUDIO_LANGUAGE", "OUTPUT_LANGUAGE"]) {
    if (!Object.hasOwn(meetingLanguages, result[key])) throw new Error("Choose a supported language.");
  }
  if (!["system", "microphone", "both"].includes(result.AUDIO_SOURCE)) throw new Error("Choose an audio source.");
  if (!/^(primary|cursor|[0-9]+)$/.test(result.OVERLAY_DISPLAY)) throw new Error("Choose a display.");
  if (!["on", "off"].includes(result.AUTO_LAUNCH)) throw new Error("Choose a login preference.");
  if (!["on", "off"].includes(result.AUTO_ANSWER)) throw new Error("Choose an auto-answer preference.");
  const opacity = Number(result.OVERLAY_OPACITY);
  if (!Number.isInteger(opacity) || opacity < 30 || opacity > 100) throw new Error("Overlay opacity must be a whole percentage between 30 and 100.");
  result.OVERLAY_OPACITY = String(opacity);
  const shortcuts = shortcutKeys.map((key) => result[key]).filter(Boolean).map((value) => normalizeShortcut(value));
  if (new Set(shortcuts).size !== shortcuts.length) throw new Error("Each action needs a different shortcut.");
  for (const key of secretKeys) {
    if (source[key] !== undefined && typeof source[key] !== "string") throw new Error("Invalid API key.");
    if (typeof source[key] === "string" && source[key].trim()) result[key] = source[key].trim();
  }
  return result as SettingsInput;
}
