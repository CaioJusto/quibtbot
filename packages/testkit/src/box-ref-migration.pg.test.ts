import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "packages/db/prisma/migrations/20260817044000_box_refs_per_bot/migration.sql",
);

function loadMigrationSql(): string {
  return readFileSync(migrationPath, "utf8");
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeMigration = hasDb ? describe : describe.skip;

/**
 * Legacy Box workspaces stored the VM id on Computer. Per-bot isolation moves that ref to
 * DesktopSession and clears Computer.providerRef for box/e2b kinds.
 */
describeMigration("box refs per bot migration", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const boxWorkspaceId = `ws-box-mig-${stamp}`;
  const dockerWorkspaceId = `ws-docker-mig-${stamp}`;
  const userId = `user-box-mig-${stamp}`;
  const legacyBoxRef = "legacy-box";
  const dockerRef = "container-workspace";

  let boxComputerId: string;
  let dockerComputerId: string;
  let boxSessionNullId: string;
  let boxSessionWithRefId: string;
  let dockerSessionId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);

    await db.prisma.organization.create({
      data: {
        id: boxWorkspaceId,
        name: "Box migration workspace",
        slug: `box-mig-${stamp}`,
        createdAt: new Date(),
      },
    });
    await db.prisma.organization.create({
      data: {
        id: dockerWorkspaceId,
        name: "Docker migration workspace",
        slug: `docker-mig-${stamp}`,
        createdAt: new Date(),
      },
    });

    const boxComputer = await db.prisma.computer.create({
      data: {
        workspaceId: boxWorkspaceId,
        userId,
        kind: "box",
        providerRef: legacyBoxRef,
        state: "running",
      },
    });
    boxComputerId = boxComputer.id;

    const boxBotA = await db.prisma.bot.create({
      data: { workspaceId: boxWorkspaceId, userId, name: "Box A", color: "#111111" },
    });
    const boxBotB = await db.prisma.bot.create({
      data: { workspaceId: boxWorkspaceId, userId, name: "Box B", color: "#222222" },
    });

    const sessionNull = await db.prisma.desktopSession.create({
      data: {
        workspaceId: boxWorkspaceId,
        computerId: boxComputerId,
        botId: boxBotA.id,
        display: 1,
        providerRef: null,
        state: "running",
      },
    });
    boxSessionNullId = sessionNull.id;

    const sessionWithRef = await db.prisma.desktopSession.create({
      data: {
        workspaceId: boxWorkspaceId,
        computerId: boxComputerId,
        botId: boxBotB.id,
        display: 2,
        providerRef: "box-b",
        state: "running",
      },
    });
    boxSessionWithRefId = sessionWithRef.id;

    const dockerComputer = await db.prisma.computer.create({
      data: {
        workspaceId: dockerWorkspaceId,
        userId,
        kind: "docker",
        providerRef: dockerRef,
        state: "running",
      },
    });
    dockerComputerId = dockerComputer.id;

    const dockerBot = await db.prisma.bot.create({
      data: { workspaceId: dockerWorkspaceId, userId, name: "Docker bot", color: "#333333" },
    });

    const dockerSession = await db.prisma.desktopSession.create({
      data: {
        workspaceId: dockerWorkspaceId,
        computerId: dockerComputerId,
        botId: dockerBot.id,
        display: 1,
        providerRef: dockerRef,
        state: "running",
      },
    });
    dockerSessionId = dockerSession.id;
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: boxWorkspaceId } }).catch(() => undefined);
    await db.prisma.organization
      .delete({ where: { id: dockerWorkspaceId } })
      .catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function readFixtureState() {
    const [boxComputer, boxSessionNull, boxSessionWithRef, dockerComputer, dockerSession] =
      await Promise.all([
        db.prisma.computer.findUniqueOrThrow({ where: { id: boxComputerId } }),
        db.prisma.desktopSession.findUniqueOrThrow({ where: { id: boxSessionNullId } }),
        db.prisma.desktopSession.findUniqueOrThrow({ where: { id: boxSessionWithRefId } }),
        db.prisma.computer.findUniqueOrThrow({ where: { id: dockerComputerId } }),
        db.prisma.desktopSession.findUniqueOrThrow({ where: { id: dockerSessionId } }),
      ]);
    return {
      boxComputer,
      boxSessionNull,
      boxSessionWithRef,
      dockerComputer,
      dockerSession,
    };
  }

  async function applyMigration() {
    await db.prisma.$executeRawUnsafe(loadMigrationSql());
  }

  it("moves legacy Box computer ref to null sessions and clears the computer ref", async () => {
    await applyMigration();

    const state = await readFixtureState();
    expect(state.boxComputer.providerRef).toBeNull();
    expect(state.boxSessionNull.providerRef).toBe(legacyBoxRef);
    expect(state.boxSessionWithRef.providerRef).toBe("box-b");
    expect(state.dockerComputer.providerRef).toBe(dockerRef);
    expect(state.dockerSession.providerRef).toBe(dockerRef);
  });

  it("is idempotent when applied a second time", async () => {
    const afterFirst = await readFixtureState();

    await applyMigration();

    const afterSecond = await readFixtureState();
    expect(afterSecond).toEqual(afterFirst);
  });
});
