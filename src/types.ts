export type OverlayStatus =
  | "hidden"
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "answer"
  | "error";

export type OverlayState = {
  status: OverlayStatus;
  text: string;
  label?: string;
  stealth?: boolean;
  exitShortcut?: string;
};

export type CopilotApi = {
  onState: (callback: (state: OverlayState) => void) => void;
  dismiss: () => void;
  resize: (height: number) => void;
};

declare global {
  interface Window {
    copilot: CopilotApi;
  }
}
