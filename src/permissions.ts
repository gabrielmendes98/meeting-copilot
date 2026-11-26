import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { speechAppPath } from "./native-bin";
import { writePrivateJson } from "./meeting-history";

export type PermissionKind = "screen" | "microphone" | "speech";
export type PermissionStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
type PermissionDependencies = {
  supported: boolean;
  readMedia: (kind: "screen" | "microphone") => string;
  readSpeech: (request: boolean) => Promise<PermissionStatus>;
  requestMedia: (kind: "screen" | "microphone") => Promise<void>;
  openSettings: (kind: PermissionKind) => Promise<void>;
  needsSpeech: () => boolean;
};
const statuses = new Set(["granted", "denied", "restricted", "not-determined", "unknown"]);
function status(value: string): PermissionStatus { return statuses.has(value) ? value as PermissionStatus : "unknown"; }

/** Query the speech helper's own TCC identity, without recording or downloading a model. */
export async function speechPermission(request: boolean): Promise<PermissionStatus> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-permissions-"));
  try {
    const output = path.join(directory, "status.json");
    await promisify(execFile)("/usr/bin/open", ["-W", "-n", "-a", speechAppPath(), "--args", request ? "--request-permission" : "--permission-status", output], { timeout: 180_000 });
    const result = JSON.parse(await fs.readFile(output, "utf8"));
    return status(result.status);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export class PermissionGate {
  private speech: PermissionStatus = "unknown";
  private completed = false;
  private pending: Promise<void> | null = null;
  private error = "";
  constructor(private readonly file: string, private readonly dependencies: PermissionDependencies) {}
  async load(): Promise<void> {
    try { this.completed = JSON.parse(await fs.readFile(this.file, "utf8")).completed === true; }
    catch { this.completed = false; }
  }
  snapshot() {
    const d = this.dependencies;
    const required: PermissionKind[] = d.needsSpeech() ? ["screen", "microphone", "speech"] : ["screen", "microphone"];
    const permissions = { screen: status(d.readMedia("screen")), microphone: status(d.readMedia("microphone")), speech: this.speech };
    const granted = !d.supported || required.every(kind => permissions[kind] === "granted");
    return { supported: d.supported, required, ...permissions, granted, ready: granted && (!d.supported || this.completed), checking: this.pending !== null, error: this.error };
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.error = "";
      if (!this.dependencies.supported || !this.dependencies.needsSpeech()) return;
      try { this.speech = await this.dependencies.readSpeech(false); }
      catch { this.speech = "unknown"; this.error = "Could not check Speech Recognition. Rebuild the speech helper, then check again."; }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async request(kind: unknown): Promise<void> {
    if (!["screen", "microphone", "speech"].includes(kind as string)) throw new Error("Unknown permission.");
    if (!this.dependencies.supported) return;
    if (this.pending) await this.pending;
    const permission = kind as PermissionKind;
    if (this.snapshot()[permission] === "granted") return;
    if (["denied", "restricted"].includes(this.snapshot()[permission])) {
      await this.dependencies.openSettings(permission);
    } else if (permission === "speech") {
      this.speech = await this.dependencies.readSpeech(true);
    } else { await this.dependencies.requestMedia(permission); }
    await this.refresh();
  }
  async complete(): Promise<void> {
    await this.refresh();
    if (!this.snapshot().granted) throw new Error("Approve the required macOS permissions before continuing.");
    writePrivateJson(this.file, { completed: true, version: 1 });
    this.completed = true;
  }
}
