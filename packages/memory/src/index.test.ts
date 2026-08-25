import type { AdapterContext } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });
});

interface DocRow {
  id: string;
  workspaceId: string;
  userId: string;
  botId: string | null;
  scope: string;
  path: string;
  content: string;
  revision: number;
}

interface RevisionRow {
  documentId: string;
  revision: number;
  content: string;
}

/**
 * Prisma stand-in that enforces the two unique constraints this store depends
 * on: one document per (workspace, scope, bot, path) and one revision per
 * (document, revision).
 */
function fakePrisma(seed: DocRow[] = []) {
  const state = { docs: [...seed], revisions: [] as RevisionRow[], nextId: seed.length + 1 };
  const unique = (error: string) =>
    Object.assign(new Error(error), { code: "P2002", meta: { modelName: "MemoryDocument" } });
  const memoryDocument = {
    findMany: async ({
      where,
      take,
    }: {
      where: Partial<DocRow> & {
        OR?: Array<{ path?: { contains: string }; content?: { contains: string } }>;
      };
      take?: number;
    }) => {
      await tick();
      const needle = where.OR?.[0]?.path?.contains?.toLowerCase();
      const rows = state.docs.filter((doc) => {
        if (doc.workspaceId !== where.workspaceId) return false;
        if (where.scope && doc.scope !== where.scope) return false;
        if (where.botId !== undefined && doc.botId !== where.botId) return false;
        if (where.path && doc.path !== where.path) return false;
        if (!needle) return true;
        return (
          doc.path.toLowerCase().includes(needle) || doc.content.toLowerCase().includes(needle)
        );
      });
      return take === undefined ? rows : rows.slice(0, take);
    },
    findFirst: async ({ where }: { where: Partial<DocRow> }) => {
      await tick();
      return (
        state.docs.find(
          (doc) =>
            doc.workspaceId === where.workspaceId &&
            doc.scope === where.scope &&
            (where.botId === undefined || doc.botId === where.botId) &&
            doc.path === where.path &&
            (where.userId === undefined || doc.userId === where.userId),
        ) ?? null
      );
    },
    create: async ({ data }: { data: Omit<DocRow, "id" | "revision"> }) => {
      await tick();
      const clash = state.docs.some(
        (doc) =>
          doc.workspaceId === data.workspaceId &&
          doc.scope === data.scope &&
          (doc.botId ?? null) === (data.botId ?? null) &&
          doc.path === data.path,
      );
      if (clash) throw unique("Unique constraint failed on memory_documents");
      const row: DocRow = {
        id: `doc-${state.nextId++}`,
        revision: 1,
        ...data,
        botId: data.botId ?? null,
      };
      state.docs.push(row);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; revision: number };
      data: { content: string; revision: number };
    }) => {
      await tick();
      const row = state.docs.find((doc) => doc.id === where.id && doc.revision === where.revision);
      if (!row) return { count: 0 };
      row.content = data.content;
      row.revision = data.revision;
      return { count: 1 };
    },
  };
  const memoryRevision = {
    create: async ({ data }: { data: RevisionRow }) => {
      await tick();
      const clash = state.revisions.some(
        (rev) => rev.documentId === data.documentId && rev.revision === data.revision,
      );
      if (clash) throw unique("Unique constraint failed on memory_revisions");
      state.revisions.push(data);
      return data;
    },
  };
  const prisma = {
    memoryDocument,
    memoryRevision,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma: prisma as unknown as PrismaClient, state };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const context: AdapterContext = {
  operationId: "mem",
  traceId: "mem",
  workspaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("MarkdownMemoryStore.commit", () => {
  it("creates the document and its first revision", async () => {
    const fake = fakePrisma();
    const store = new MarkdownMemoryStore(fake.prisma);
    const result = await store.commit(
      { scope: "user", path: "MEMORY.md", content: "one" },
      context,
    );
    expect(result.revision).toBe(1);
    expect(fake.state.docs).toHaveLength(1);
    expect(fake.state.revisions).toHaveLength(1);
    expect(fake.state.revisions[0]).toMatchObject({
      documentId: result.id,
      revision: 1,
      content: "one",
    });
  });

  it("gives concurrent writers distinct revisions without losing content", async () => {
    const fake = fakePrisma([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        userId: "user-1",
        botId: null,
        scope: "user",
        path: "MEMORY.md",
        content: "base",
        revision: 1,
      },
    ]);
    const store = new MarkdownMemoryStore(fake.prisma);
    const [first, second] = await Promise.all([
      store.commit({ scope: "user", path: "MEMORY.md", content: "from A" }, context),
      store.commit({ scope: "user", path: "MEMORY.md", content: "from B" }, context),
    ]);
    expect(new Set([first.revision, second.revision])).toEqual(new Set([2, 3]));
    const doc = fake.state.docs[0];
    expect(doc?.revision).toBe(3);
    // The last writer's content is what the document holds, and every revision
    // was persisted exactly once.
    const latest = fake.state.revisions.find((rev) => rev.revision === 3);
    expect(latest?.content).toBe(doc?.content);
    expect(fake.state.revisions.map((rev) => rev.revision).sort()).toEqual([2, 3]);
  });

  it("updates a document owned by another member of the same workspace", async () => {
    const fake = fakePrisma([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        userId: "user-2",
        botId: null,
        scope: "user",
        path: "MEMORY.md",
        content: "base",
        revision: 1,
      },
    ]);
    const store = new MarkdownMemoryStore(fake.prisma);
    const result = await store.commit(
      { scope: "user", path: "MEMORY.md", content: "next" },
      context,
    );
    expect(result.revision).toBe(2);
    expect(fake.state.docs).toHaveLength(1);
    const snapshot = await store.read({ scope: "user", path: "MEMORY.md" }, context);
    expect(snapshot.documents).toEqual([
      { id: "doc-1", path: "MEMORY.md", content: "next", revision: 2 },
    ]);
  });
});

describe("MarkdownMemoryStore.search", () => {
  it("filters in the query and caps the result set", async () => {
    const fake = fakePrisma(
      Array.from({ length: 3 }, (_, i) => ({
        id: `doc-${i}`,
        workspaceId: "ws-1",
        userId: "user-2",
        botId: null,
        scope: "user",
        path: i === 0 ? "notes.md" : `other-${i}.md`,
        content: i === 0 ? "hello search" : "unrelated",
        revision: 1,
      })),
    );
    const store = new MarkdownMemoryStore(fake.prisma);
    const hits = await store.search({ scope: "user", query: "hello" }, context);
    expect(hits).toEqual([
      expect.objectContaining({ path: "notes.md", snippet: expect.stringContaining("hello") }),
    ]);
  });
});
