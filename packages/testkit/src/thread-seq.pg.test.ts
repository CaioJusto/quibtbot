import { appendEvent, appendThreadMessage, createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const describeSeq = hasDb ? describe : describe.skip;

/**
 * `seq` is read-modify-write behind `pg_advisory_xact_lock`, and `[threadId, seq]` is unique:
 * only a real database says whether concurrent writers serialize, skip a number or collide.
 */
describeSeq("thread sequence numbers under concurrency", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-seq-${stamp}`;
  const userId = `user-seq-${stamp}`;
  let threadId: string;
  let otherThreadId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: { id: workspaceId, name: "Seq workspace", slug: `seq-${stamp}`, createdAt: new Date() },
    });
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Seq", color: "#123456" },
    });
    const other = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Seq other", color: "#654321" },
    });
    threadId = (await db.prisma.thread.create({ data: { workspaceId, userId, botId: bot.id } })).id;
    otherThreadId = (
      await db.prisma.thread.create({ data: { workspaceId, userId, botId: other.id } })
    ).id;
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("numbers concurrent events without a gap, a repeat or a unique violation", async () => {
    const writes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        appendEvent(db.prisma, {
          workspaceId,
          threadId,
          type: "thread.progress",
          payload: { index },
        }),
      ),
    );
    expect(writes.filter((write) => write.status === "rejected")).toEqual([]);
    const seqs = (
      await db.prisma.event.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
        select: { seq: true },
      })
    ).map((row) => row.seq);
    expect(seqs).toEqual([...Array(12).keys()]);
  });

  it("numbers concurrent messages per thread, and threads do not share a counter", async () => {
    const writes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        appendThreadMessage(db.prisma, {
          threadId: index % 2 === 0 ? threadId : otherThreadId,
          role: "user",
          blocks: [{ kind: "text", text: `m${index}` }],
        }),
      ),
    );
    expect(writes.filter((write) => write.status === "rejected")).toEqual([]);
    for (const id of [threadId, otherThreadId]) {
      const seqs = (
        await db.prisma.message.findMany({
          where: { threadId: id },
          orderBy: { seq: "asc" },
          select: { seq: true },
        })
      ).map((row) => row.seq);
      expect(seqs).toEqual([...Array(6).keys()]);
    }
  });
});
