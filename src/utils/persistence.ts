import * as fs from "fs";
import * as path from "path";
import { RoleType } from "../game/types";

export interface PersistedSettings {
  hostUserId: string;
  participants: string[];
  roleDistribution: Partial<Record<RoleType, number>>;
  meetingTimeMinutes: number;
  anonymousVoting: boolean;
}

export class PersistenceManager {
  private filePath: string;
  private data: Map<string, PersistedSettings> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, PersistedSettings>;
        for (const [guildId, settings] of Object.entries(parsed)) {
          this.data.set(guildId, settings);
        }
      }
    } catch (e) {
      console.error("Failed to load persisted settings:", e);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, PersistedSettings> = {};
      for (const [guildId, settings] of this.data) {
        obj[guildId] = settings;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save persisted settings:", e);
    }
  }

  getSettings(guildId: string): PersistedSettings | undefined {
    return this.data.get(guildId);
  }

  setSettings(guildId: string, settings: PersistedSettings): void {
    this.data.set(guildId, settings);
    this.save();
  }

  deleteSettings(guildId: string): void {
    this.data.delete(guildId);
    this.save();
  }
}
