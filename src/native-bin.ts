import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export function nativeBin(name: string): string {
  const packaged = path.join(process.resourcesPath, name);
  const dev = path.join(__dirname, "bin", name);
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    `Helper ${name} not found. Run npm run build in the project.`,
  );
}

export function speechAppPath(): string {
  const packaged = path.join(
    process.resourcesPath,
    "Meeting Copilot Speech.app",
  );
  const dev = path.join(__dirname, "bin", "Meeting Copilot Speech.app");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    "Speech app not found. Run npm run build in the project.",
  );
}
