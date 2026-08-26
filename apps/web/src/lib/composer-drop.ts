/**
 * Arquivo que chega arrastado ou colado.
 *
 * Fora do campo, soltar um arquivo em cima do navegador troca a página do Quibt pelo
 * arquivo — a conversa some e o que estava escrito vai junto. Por isso quem lê o arrastar
 * é o app, e não o navegador: aqui só sai a lista de arquivos, e quem chama trata de
 * segurar o evento.
 *
 * Enquanto o arquivo está no ar, `files` vem vazio de propósito (o navegador só entrega os
 * bytes no soltar). Para acender a moldura durante o arrastar sobra `types`/`items`, que é
 * o que `transferHasFiles` olha.
 */

type TransferItem = {
  kind?: string;
  getAsFile?: () => File | null;
};

/** O pouco que interessa de um DataTransfer, para o arrastar e para o colar. */
export type FileTransfer = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<TransferItem> | null;
  types?: ArrayLike<string> | null;
};

function toArray<T>(list: ArrayLike<T> | null | undefined): T[] {
  return list ? Array.from(list) : [];
}

export function filesFromTransfer(transfer: FileTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const direct = toArray(transfer.files);
  if (direct.length) return direct;
  // Colar no Chrome entrega a imagem da área de transferência por `items`, não por `files`.
  return toArray(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => file != null);
}

/** Tem arquivo vindo? Vale durante o arrastar, quando os bytes ainda não chegaram. */
export function transferHasFiles(transfer: FileTransfer | null | undefined): boolean {
  if (!transfer) return false;
  if (toArray(transfer.types).includes("Files")) return true;
  if (toArray(transfer.items).some((item) => item.kind === "file")) return true;
  return toArray(transfer.files).length > 0;
}
