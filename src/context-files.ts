import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog } from "electron";
import { CONTEXT_EXTENSIONS, extractContextDocument, MAX_CONTEXT_CHARACTERS } from "./context-extraction";

type ContextFile = { id: string; name: string; path: string; size: number; addedAt: string; text?: string; error?: string };
function libraryPath(): string { return path.join(app.getPath("userData"), "context-files.json"); }
function read(): ContextFile[] {
  if (!fs.existsSync(libraryPath())) return [];
  return JSON.parse(fs.readFileSync(libraryPath(), "utf8"));
}
function write(files: ContextFile[]): void {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(`${libraryPath()}.tmp`, JSON.stringify(files, null, 2), { mode: 0o600 });
  fs.renameSync(`${libraryPath()}.tmp`, libraryPath());
}
export function listContextFiles() {
  return read().map(({ path: filePath, text, ...file }) => ({ ...file, available: !file.error && (text !== undefined || fs.existsSync(filePath)) }));
}
function textPath(): string { return path.join(app.getPath("userData"), "context-text.json"); }
export function getContextText(): string {
  return fs.existsSync(textPath()) ? JSON.parse(fs.readFileSync(textPath(), "utf8")) : "";
}
function validateSize(files: Array<{ text?: string }>, text: string): void {
  if (files.reduce((total, file) => total + (file.text?.length ?? 0), text.length) > MAX_CONTEXT_CHARACTERS) {
    throw new Error("Context exceeds 120,000 characters. Remove documents or shorten the text before saving.");
  }
}
export function saveContextText(text: unknown): string {
  if (typeof text !== "string") throw new Error("Invalid context text.");
  validateSize(read(), text);
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(`${textPath()}.tmp`, JSON.stringify(text), { mode: 0o600 });
  fs.renameSync(`${textPath()}.tmp`, textPath());
  return text;
}
export async function addContextFiles(window: BrowserWindow) {
  const result = await dialog.showOpenDialog(window, {
    title: "Add meeting context", properties: ["openFile", "multiSelections"],
    filters: [{ name: "Documents", extensions: CONTEXT_EXTENSIONS }],
  });
  if (result.canceled) return listContextFiles();
  for (const filePath of result.filePaths) {
    if (read().some((file) => file.path === filePath)) continue;
    const entry: ContextFile = { id: randomUUID(), name: path.basename(filePath), path: filePath, size: 0, addedAt: new Date().toISOString() };
    try {
      entry.text = await extractContextDocument(filePath);
      entry.size = fs.statSync(filePath).size;
      validateSize([...read(), entry], getContextText());
    } catch (error) {
      delete entry.text;
      entry.error = error instanceof Error ? error.message : "Could not read this document.";
    }
    // Re-read after extraction so concurrent removals or imports cannot be overwritten.
    const files = read();
    if (files.some((file) => file.path === filePath)) continue;
    files.push(entry);
    write(files);
  }
  return listContextFiles();
}

/** Snapshot every source for this request, including legacy file references. */
export async function getAgentContext(): Promise<string> {
  const files = read();
  const text = getContextText().trim();
  const sources: Array<{ name: string; text: string }> = [];
  for (const file of files) {
    if (file.error) continue; // Failed imports are explicitly marked as excluded in the UI.
    try { sources.push({ name: file.name, text: file.text ?? await extractContextDocument(file.path) }); }
    catch { throw new Error(`Could not read context document "${file.name}". Remove it and import it again.`); }
  }
  validateSize(sources, text);
  if (text) sources.push({ name: "User notes", text });
  return sources.length ? `Reference context (JSON sources):\n${JSON.stringify(sources)}\n\n` : "";
}
export function removeContextFile(id: string) {
  write(read().filter((file) => file.id !== id));
  return listContextFiles();
}
