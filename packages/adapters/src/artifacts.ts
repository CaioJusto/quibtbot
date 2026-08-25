import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@quibt/adapter-kit";

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  describe() {
    return {
      id: "local-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = `${context.workspaceId}-${Date.now()}`;
    const dir = path.join(this.root, "artifacts", context.workspaceId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, id);
    await writeFile(file, artifact.bytes);
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    return new Uint8Array(await readFile(this.artifactPath(id, context)));
  }

  async remove(id: string, context: AdapterContext) {
    await rm(this.artifactPath(id, context), { force: true });
  }

  private artifactPath(id: string, context: AdapterContext): string {
    const dir = path.resolve(this.root, "artifacts", context.workspaceId);
    const candidate = path.resolve(dir, id);
    if (path.basename(id) !== id || !candidate.startsWith(`${dir}${path.sep}`)) {
      throw new Error("Invalid artifact id");
    }
    return candidate;
  }
}

export class CapturingNotificationProvider implements NotificationProvider {
  readonly sent: NotificationMessage[] = [];

  describe() {
    return {
      id: "capturing",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: false, email: false },
    };
  }

  async send(message: NotificationMessage, _context: AdapterContext): Promise<void> {
    this.sent.push(message);
  }
}
