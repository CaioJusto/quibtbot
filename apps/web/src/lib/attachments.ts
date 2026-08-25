/**
 * Arquivos que sobem junto com o recado. Passam por uma rota HTTP comum, e não pelo RPC,
 * porque são bytes: o upload vai como multipart e o download volta como o arquivo mesmo.
 */

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  image?: boolean;
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentTooBig(size: number): boolean {
  return size > MAX_ATTACHMENT_BYTES;
}

export async function uploadAttachment(botId: string, file: File | Blob, name?: string) {
  const form = new FormData();
  form.append("file", file, name ?? (file instanceof File ? file.name : "arquivo"));
  const response = await fetch(`/files/${encodeURIComponent(botId)}`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message ?? "Não deu para enviar o arquivo.");
  }
  return (await response.json()) as Attachment;
}
