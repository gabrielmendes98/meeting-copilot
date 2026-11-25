import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Meeting = {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  transcript: string;
  notes: string;
};

export type MeetingListItem = Omit<Meeting, "transcript" | "notes"> & { hasNotes: boolean };

export function boundedText(input: unknown, max: number, label: string, optional = false): string {
  if (typeof input !== "string" || input.length > max || (!optional && !input.trim())) {
    throw new Error(`${label} must ${optional ? "contain at most" : "contain between 1 and"} ${max} characters.`);
  }
  return input.trim();
}

export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export class MeetingHistory {
  constructor(private readonly directory: string) {}

  private file(id: unknown): string {
    if (typeof id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id)) {
      throw new Error("Invalid meeting identifier.");
    }
    return path.join(this.directory, `${id}.json`);
  }

  add(startedAt: number, transcript: string): Meeting {
    const meeting: Meeting = {
      id: randomUUID(),
      title: `Meeting · ${new Date(startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
      startedAt, endedAt: Date.now(), transcript: transcript.trim(), notes: "",
    };
    writePrivateJson(this.file(meeting.id), meeting);
    return meeting;
  }

  get(id: unknown): Meeting {
    const file = this.file(id);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Meeting;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Meeting is no longer in history.");
      throw error;
    }
  }

  edit(id: unknown, title: unknown, notes: unknown): Meeting {
    const meeting = this.get(id);
    meeting.title = boundedText(title, 160, "Title");
    meeting.notes = boundedText(notes, 120_000, "Notes", true);
    writePrivateJson(this.file(id), meeting);
    return meeting;
  }

  delete(id: unknown): void {
    fs.rmSync(this.file(id), { force: true });
  }

  list(query = ""): MeetingListItem[] {
    if (!fs.existsSync(this.directory)) return [];
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const items: MeetingListItem[] = [];
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const meeting = this.get(entry.name.slice(0, -5));
        if (terms.length) {
          const searchable = `${meeting.title}\n${meeting.notes}\n${meeting.transcript}`.toLocaleLowerCase();
          if (!terms.every((term) => searchable.includes(term))) continue;
        }
        items.push({ id: meeting.id, title: meeting.title, startedAt: meeting.startedAt, endedAt: meeting.endedAt, hasNotes: Boolean(meeting.notes) });
      } catch {
        // One unreadable file must leave the rest of the history accessible.
      }
    }
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }

  markdown(id: unknown): string {
    const meeting = this.get(id);
    return [`# ${meeting.title}`, new Date(meeting.startedAt).toISOString(), "## Notes", meeting.notes, "## Transcript", meeting.transcript, ""].join("\n\n");
  }
}
