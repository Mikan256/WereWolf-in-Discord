import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { RoleType } from "../game/types";

export interface PersistedSettings {
  hostUserId: string;
  participants: string[];
  roleDistribution: Partial<Record<RoleType, number>>;
  meetingTimeMinutes: number;
  anonymousVoting: boolean;
}

export class PersistenceManager {
  private data: Map<string, PersistedSettings> = new Map();
  private s3: S3Client | null = null;
  private bucket: string;
  private key: string;

  constructor() {
    this.bucket = process.env.KOYEB_S3_BUCKET || "";
    this.key = process.env.KOYEB_S3_KEY || "settings.json";
    if (this.bucket) {
      this.s3 = new S3Client({
        region: process.env.KOYEB_S3_REGION || "us-east-1",
        endpoint: process.env.KOYEB_S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.KOYEB_S3_ACCESS_KEY || "",
          secretAccessKey: process.env.KOYEB_S3_SECRET_KEY || "",
        },
        forcePathStyle: true,
      });
    }
  }

  async init(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    if (!this.s3) return;
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }));
      const body = await response.Body?.transformToString("utf-8");
      if (body) {
        const parsed = JSON.parse(body) as Record<string, PersistedSettings>;
        for (const [guildId, settings] of Object.entries(parsed)) {
          this.data.set(guildId, settings);
        }
        console.log(`[Persistence] Loaded ${Object.keys(parsed).length} guild(s) from S3`);
      }
    } catch (e: any) {
      if (e.name === "NoSuchKey") {
        console.log("[Persistence] No saved settings in S3, starting fresh");
      } else {
        console.error("[Persistence] Failed to load from S3:", e);
      }
    }
  }

  private async save(): Promise<void> {
    if (!this.s3) return;
    const obj: Record<string, PersistedSettings> = {};
    for (const [guildId, settings] of this.data) {
      obj[guildId] = settings;
    }
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Body: JSON.stringify(obj, null, 2),
      ContentType: "application/json",
    }));
  }

  getSettings(guildId: string): PersistedSettings | undefined {
    return this.data.get(guildId);
  }

  async setSettings(guildId: string, settings: PersistedSettings): Promise<void> {
    this.data.set(guildId, settings);
    try {
      await this.save();
    } catch (e) {
      console.error("[Persistence] Failed to save to S3:", e);
      throw new Error("設定の保存に失敗しました。");
    }
  }

  async deleteSettings(guildId: string): Promise<void> {
    this.data.delete(guildId);
    try {
      await this.save();
    } catch (e) {
      console.error("[Persistence] Failed to save to S3:", e);
      throw new Error("設定の保存に失敗しました。");
    }
  }
}
