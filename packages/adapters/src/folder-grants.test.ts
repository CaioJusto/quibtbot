import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addFolderGrant,
  loadAllFolderGrants,
  loadFolderGrants,
  loadFolderGrantsByUser,
} from "./folder-grants.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("folder grants", () => {
  it("persists and loads desktop grants without merging user authority", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "quibt-grants-"));
    dirs.push(dataDir);
    await addFolderGrant(dataDir, "user-a", "/tmp/granted-a");
    await addFolderGrant(dataDir, "user-a", "/tmp/granted-a");
    await addFolderGrant(dataDir, "user-b", "/tmp/granted-b");
    expect(await loadFolderGrants(dataDir, "user-a")).toEqual([path.resolve("/tmp/granted-a")]);
    expect(await loadAllFolderGrants(dataDir)).toEqual([
      path.resolve("/tmp/granted-a"),
      path.resolve("/tmp/granted-b"),
    ]);
    expect(await loadFolderGrantsByUser(dataDir)).toEqual({
      "user-a": [path.resolve("/tmp/granted-a")],
      "user-b": [path.resolve("/tmp/granted-b")],
    });
  });
});
