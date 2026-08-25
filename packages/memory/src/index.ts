import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        workspaceId: context.workspaceId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const q = request.query.trim();
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(request.scope === "all" ? {} : { scope: request.scope }),
        ...(request.botId ? { botId: request.botId } : {}),
        ...(q
          ? {
              OR: [
                { path: { contains: q, mode: "insensitive" } },
                { content: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      take: MEMORY_SEARCH_LIMIT,
    });
    const needle = q.toLowerCase();
    return documents.map((doc) => ({
      path: doc.path,
      snippet: snippet(doc.content, needle),
      score: 1,
    }));
  }

  /**
   * A revisão nunca é calculada em memória e escrita às cegas: o update é
   * condicional à revisão lida (compare-and-set) e o registro histórico entra
   * na mesma transação. Duas escritas concorrentes produzem revisões
   * distintas — a perdedora relê o documento e reaplica o conteúdo — em vez de
   * violar a unique de `memory_revisions` depois de já ter sobrescrito o texto.
   *
   * A busca usa a chave única real do documento (workspace, escopo, bot,
   * caminho), sem `userId`: o banco só permite um documento por essa chave.
   */
  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const existing = await this.prisma.memoryDocument.findFirst({
        where: {
          workspaceId: context.workspaceId,
          scope: request.scope,
          botId: request.botId ?? null,
          path: request.path,
        },
      });
      if (!existing) {
        const created = await this.createDocument(request, context);
        if (!created) continue; // outra escrita criou o documento primeiro
        return created;
      }
      const revision = existing.revision + 1;
      const applied = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.memoryDocument.updateMany({
          where: { id: existing.id, revision: existing.revision },
          data: { content: request.content, revision },
        });
        if (claimed.count !== 1) return false;
        await tx.memoryRevision.create({
          data: {
            documentId: existing.id,
            revision,
            content: request.content,
            sourceRunId: request.sourceRunId,
            sourceThreadId: request.sourceThreadId,
          },
        });
        return true;
      });
      if (!applied) continue; // alguém escreveu antes: relê e tenta de novo
      return { id: existing.id, path: existing.path, revision, content: request.content };
    }
    throw new Error(`Memory document "${request.path}" is being written too fast; try again`);
  }

  /** `null` quando outra escrita concorrente criou o mesmo documento. */
  private async createDocument(
    request: MemoryCommitRequest,
    context: AdapterContext,
  ): Promise<MemoryRevision | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const doc = await tx.memoryDocument.create({
          data: {
            workspaceId: context.workspaceId,
            userId: context.userId,
            botId: request.botId,
            scope: request.scope,
            path: request.path,
            content: request.content,
          },
        });
        await tx.memoryRevision.create({
          data: {
            documentId: doc.id,
            revision: doc.revision,
            content: request.content,
            sourceRunId: request.sourceRunId,
            sourceThreadId: request.sourceThreadId,
          },
        });
        return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

const MAX_COMMIT_ATTEMPTS = 5;
const MEMORY_SEARCH_LIMIT = 40;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
