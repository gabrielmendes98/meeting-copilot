import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { boundedText, writePrivateJson } from "./meeting-history";

export type MeetingMode = { id: string; title: string; instructions: string; referenceIds?: string[] };
const builtIn: MeetingMode[] = [
  { id: "general", title: "General", instructions: "Give concise, practical assistance for the current task." },
  { id: "meeting", title: "Meeting", instructions: "Prioritize decisions, open issues, owners, and actionable next steps." },
  { id: "interview", title: "Interview", instructions: "Give clear talking points grounded in the user's experience and the available material. Never invent experience." },
  { id: "sales", title: "Sales call", instructions: "Identify buyer priorities and objections. Suggest useful discovery questions and next steps." },
  { id: "behavioral-interview", title: "Behavioral interview", instructions: "Structure answers around the situation, action, and result. Use only experience the user has provided." },
  { id: "coding-interview", title: "Coding interview", instructions: "Clarify constraints, explain the algorithm and complexity, and suggest tests for edge cases." },
  { id: "system-design", title: "System design", instructions: "Identify requirements, data flow, interfaces, and capacity. Explain operational tradeoffs and failure modes." },
  { id: "case-interview", title: "Case interview", instructions: "State a hypothesis, break down the problem, and show assumptions and calculations." },
  { id: "recruiter-screen", title: "Recruiter screen", instructions: "Surface relevant experience, clarify role expectations, and help formulate questions about the position." },
  { id: "recruiting", title: "Recruiting", instructions: "Organize job-relevant observations and flag follow-up questions. Do not infer personal characteristics." },
  { id: "lecture", title: "Lecture", instructions: "Define key concepts and explain them with clear examples. Distinguish the lecturer's claims from outside context." },
  { id: "technical", title: "Technical", instructions: "Explain assumptions, verify calculations and reasoning, and give testable suggestions." },
];
type ModePreferences = { selected: string; custom: MeetingMode[] };

export class MeetingModes {
  private preferences: ModePreferences = { selected: "general", custom: [] };

  constructor(private readonly file: string) {}

  load(): void {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as ModePreferences;
      if (!Array.isArray(saved.custom)) throw new Error("Cannot read saved meeting modes.");
      this.preferences = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private commit(next: ModePreferences): void {
    writePrivateJson(this.file, next);
    this.preferences = next;
  }

  list() {
    return { selected: this.active().id, modes: [...builtIn, ...this.preferences.custom] };
  }

  active(): MeetingMode {
    return [...builtIn, ...this.preferences.custom].find((mode) => mode.id === this.preferences.selected) ?? builtIn[0];
  }

  choose(id: unknown): void {
    if (![...builtIn, ...this.preferences.custom].some((mode) => mode.id === id)) throw new Error("Unknown meeting mode.");
    this.commit({ ...this.preferences, selected: id as string });
  }

  save(id: unknown, title: unknown, instructions: unknown, references?: unknown): void {
    const existing = this.preferences.custom.find((mode) => mode.id === id);
    if (id !== null && !existing) throw new Error("Only custom modes can be edited.");
    if (references != null && (!Array.isArray(references) || references.length > 1_000 ||
        references.some((item) => typeof item !== "string" || !item.length || item.length > 100))) {
      throw new Error("Invalid mode reference files.");
    }
    const referenceIds = Array.isArray(references) ? [...new Set<string>(references)] : references === null ? undefined : existing?.referenceIds;
    const mode: MeetingMode = {
      id: existing?.id ?? randomUUID(),
      title: boundedText(title, 60, "Mode name"),
      instructions: boundedText(instructions, 8_000, "Mode instructions"), referenceIds,
    };
    const custom = this.preferences.custom.filter((item) => item.id !== mode.id);
    this.commit({ selected: mode.id, custom: [...custom, mode] });
  }

  remove(id: unknown): void {
    if (!this.preferences.custom.some((mode) => mode.id === id)) throw new Error("Only custom modes can be deleted.");
    this.commit({
      selected: this.preferences.selected === id ? "general" : this.preferences.selected,
      custom: this.preferences.custom.filter((mode) => mode.id !== id),
    });
  }
}
