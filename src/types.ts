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
  opacity?: number;
  shortcuts?: { record: string; answer: string; summary: string; notes: string; screenshot: string; toggle: string; stealth: string };
};

export type CopilotApi = {
  onState: (callback: (state: OverlayState) => void) => void;
  dismiss: () => void;
  resize: (height: number) => void;
  onScroll: (callback: (distance: number) => void) => void;
};

declare global {
  interface Window {
    copilot: CopilotApi;
  }
}
