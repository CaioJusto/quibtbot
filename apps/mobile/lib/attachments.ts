/**
 * Arquivos que sobem junto com o recado. Passam por HTTP multipart, não pelo RPC,
 * porque são bytes — o mesmo contrato do web (`apps/web/src/lib/attachments.ts`).
 */

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  image?: boolean;
};

/** Resultado normalizado de image/document picker no mobile. */
export type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentTooBig(size: number): boolean {
  return size > MAX_ATTACHMENT_BYTES;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function fileUrl(artifactId: string, apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/files/${encodeURIComponent(artifactId)}`;
}

type UploadOptions = {
  apiBase: string;
  authHeaders?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/** RN/Expo multipart file descriptor — what `FormData.append` expects on-device. */
export type RNFilePart = {
  uri: string;
  name: string;
  type: string;
  size: number;
};

/**
 * Pure builder for the RN multipart file part, kept separate from `FormData` so it can
 * be unit tested (filename, MIME, size) without depending on a spec-compliant `Blob`.
 */
export function buildFilePart(file: PickedFile): RNFilePart {
  return { uri: file.uri, name: file.name, type: file.mimeType, size: file.size };
}

function appendFileToForm(form: FormData, file: PickedFile) {
  const part = buildFilePart(file);
  form.append("file", part as unknown as Blob, part.name);
}

export async function uploadAttachment(
  botId: string,
  file: PickedFile,
  options: UploadOptions,
): Promise<Attachment> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  appendFileToForm(form, file);
  try {
    const response = await fetchImpl(
      `${options.apiBase.replace(/\/+$/, "")}/files/${encodeURIComponent(botId)}`,
      {
        method: "POST",
        body: form,
        headers: options.authHeaders,
        signal: options.signal,
      },
    );
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        typeof detail === "object" && detail && "message" in detail
          ? String((detail as { message?: string }).message)
          : "Não deu para enviar o arquivo.",
      );
    }
    return (await response.json()) as Attachment;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("Envio cancelado.");
    }
    throw error;
  }
}

export function buildSendWithAttachmentsPayload(input: {
  botId: string;
  text: string;
  clientNonce?: string;
  attachments?: Attachment[];
  replyToId?: string;
  mentionBotIds?: string[];
}) {
  const attachments = input.attachments?.map((file) => file.id);
  const text = input.text.trim()
    ? input.text
    : (input.attachments?.map((file) => file.name).join(", ") ?? "");
  return {
    botId: input.botId,
    text,
    clientNonce: input.clientNonce,
    attachments: attachments?.length ? attachments : undefined,
    replyToId: input.replyToId,
    mentionBotIds: input.mentionBotIds?.length ? input.mentionBotIds : undefined,
  };
}

export async function openAttachmentFile(
  artifactId: string,
  name: string,
  options: { apiBase: string; authHeaders: Record<string, string> },
) {
  const [FileSystem, Sharing] = await Promise.all([
    import("expo-file-system/legacy"),
    import("expo-sharing"),
  ]);
  const url = fileUrl(artifactId, options.apiBase);
  const dest = `${FileSystem.cacheDirectory}${name.replace(/[^\w.-]+/g, "_")}`;
  const downloaded = await FileSystem.downloadAsync(url, dest, { headers: options.authHeaders });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(downloaded.uri);
    return;
  }
  const { default: Linking } = await import("expo-linking");
  await Linking.openURL(downloaded.uri);
}
