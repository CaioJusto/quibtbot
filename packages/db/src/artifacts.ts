import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "./client.js";

/**
 * Arquivos do fio: o print que o bot tirou, o PDF que ele gerou, a planilha que você
 * mandou. Os bytes ficam em disco, sob a pasta do workspace; a linha no banco é quem
 * diz de quem é o arquivo, e é ela que autoriza a leitura.
 *
 * Nada de S3 aqui de propósito: o produto é local-first e a instalação padrão não tem
 * bucket. `ARTIFACTS_DIR` aponta para um volume quando o operador quiser outro lugar.
 */

/** Um arquivo grande demais atravessa o modelo e o navegador; 25 MB já cobre print, PDF e planilha. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export function artifactsRoot(): string {
  return process.env.ARTIFACTS_DIR?.trim() || path.join(process.cwd(), "data", "artifacts");
}

/** Imagens aparecem inteiras no fio; o resto vira cartão para baixar. */
export function isImage(mimeType: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif)$/.test(mimeType);
}

/** O nome vem do modelo ou do disco do usuário: fica só o nome, sem caminho nem surpresa. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "arquivo";
  // Fora caracteres de controle, que sujam o cabeçalho do download.
  const clean = Array.from(base)
    .filter((char) => char.codePointAt(0)! > 31 && char.codePointAt(0) !== 127)
    .join("")
    .trim();
  return (clean || "arquivo").slice(0, 120);
}

export type StoredArtifact = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export async function putArtifact(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    botId: string;
    userId: string;
    runId?: string | null;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<StoredArtifact> {
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`O arquivo passa de ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB.`);
  }
  const name = safeName(input.name);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await prisma.artifact.create({
    data: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      userId: input.userId,
      runId: input.runId ?? null,
      name,
      mimeType: input.mimeType || "application/octet-stream",
      size: input.bytes.byteLength,
      hash,
      storageKey: "",
    },
  });
  const dir = path.join(artifactsRoot(), input.workspaceId);
  await mkdir(dir, { recursive: true });
  const key = path.join(input.workspaceId, row.id);
  await writeFile(path.join(artifactsRoot(), key), input.bytes);
  await prisma.artifact.update({ where: { id: row.id }, data: { storageKey: key } });
  return { id: row.id, name, mimeType: row.mimeType, size: row.size };
}

/** Lê um arquivo já sabendo de quem ele é: a linha do banco é a autorização. */
export async function readArtifact(
  prisma: PrismaClient,
  workspaceId: string,
  artifactId: string,
): Promise<{ bytes: Uint8Array; name: string; mimeType: string } | null> {
  const row = await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId } });
  if (!row?.storageKey) return null;
  // A chave é montada aqui, nunca vem de fora; ainda assim, um caminho que escape da
  // pasta do workspace é recusado em vez de lido.
  const full = path.resolve(artifactsRoot(), row.storageKey);
  const base = path.resolve(artifactsRoot(), workspaceId);
  if (!full.startsWith(`${base}${path.sep}`)) return null;
  try {
    return { bytes: new Uint8Array(await readFile(full)), name: row.name, mimeType: row.mimeType };
  } catch {
    return null;
  }
}
