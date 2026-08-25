import { randomUUID } from "node:crypto";

export interface SshInspectionRecord {
  inspectionId: string;
  hostname: string;
  ip: string;
  port: number;
  username: string;
  algorithm: string;
  fingerprint: string;
  expiresAt: number;
}

export class SshInspectionStore {
  private readonly ttlMs: number;
  private readonly records = new Map<string, SshInspectionRecord>();

  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
  }

  create(input: Omit<SshInspectionRecord, "inspectionId" | "expiresAt">): SshInspectionRecord {
    this.pruneExpired();
    const record: SshInspectionRecord = {
      ...input,
      inspectionId: randomUUID(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.records.set(record.inspectionId, record);
    return record;
  }

  consume(inspectionId: string): SshInspectionRecord | null {
    this.pruneExpired();
    const record = this.records.get(inspectionId);
    if (!record) return null;
    this.records.delete(inspectionId);
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  peek(inspectionId: string): SshInspectionRecord | null {
    this.pruneExpired();
    const record = this.records.get(inspectionId);
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
  }
}
