import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";

const context = {
  workspaceId: "workspace-1",
  userId: "user-1",
  operationId: "operation-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

describe("LocalArtifactStore path confinement", () => {
  it("reads and removes artifacts created inside the workspace directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "quibt-artifacts-"));
    const store = new LocalArtifactStore(root);
    const created = await store.put(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream", name: "a.bin" },
      context,
    );

    expect(await store.get(created.id, context)).toEqual(new Uint8Array([1, 2, 3]));
    await store.remove(created.id, context);
    await expect(store.get(created.id, context)).rejects.toThrow();
  });

  it("rejects traversal for reads and deletes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "quibt-artifacts-"));
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "keep");
    const store = new LocalArtifactStore(root);

    await expect(store.get("../../outside.txt", context)).rejects.toThrow("Invalid artifact id");
    await expect(store.remove("../../outside.txt", context)).rejects.toThrow("Invalid artifact id");
    expect(await readFile(outside, "utf8")).toBe("keep");
  });
});
