import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog } from "electron";

type ContextFile = { id: string; name: string; path: string; size: number; addedAt: string };
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
  return read().map(({ path: filePath, ...file }) => ({ ...file, available: fs.existsSync(filePath) }));
}
export async function addContextFiles(window: BrowserWindow) {
  const result = await dialog.showOpenDialog(window, {
    title: "Add meeting context", properties: ["openFile", "multiSelections"],
    filters: [{ name: "Documents", extensions: ["pdf", "txt", "md"] }],
  });
  if (result.canceled) return listContextFiles();
  const files = read();
  for (const filePath of result.filePaths) {
    if (!/\.(pdf|txt|md)$/i.test(filePath) || files.some((file) => file.path === filePath)) continue;
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) continue;
    files.push({ id: randomUUID(), name: path.basename(filePath), path: filePath, size: stats.size, addedAt: new Date().toISOString() });
  }
  write(files);
  return listContextFiles();
}
export function removeContextFile(id: string) {
  write(read().filter((file) => file.id !== id));
  return listContextFiles();
}
