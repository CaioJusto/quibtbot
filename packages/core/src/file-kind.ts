/**
 * O que o visualizador de arquivos consegue mostrar dentro do app — a mesma decisão no
 * web e no celular. O tipo MIME manda; quando ele vem genérico (octet-stream), a
 * extensão do nome desempata. "other" é o resto: baixa/compartilha em vez de fingir
 * que abre.
 */
export type FileViewerKind = "image" | "video" | "audio" | "text" | "other";

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/csv",
]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "tsv",
  "xml",
  "yml",
  "yaml",
  "log",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "sh",
  "sql",
  "toml",
  "ini",
  "env",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "aac", "flac"]);

function extensionOf(name: string | undefined): string {
  const clean = (name ?? "").split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function fileViewerKind(mimeType: string | undefined, name?: string): FileViewerKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || TEXT_MIMES.has(mime)) return "text";
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "other";
}

/** Teto do que o visualizador de texto lê para a tela: acima disso é arquivo para baixar. */
export const TEXT_VIEWER_MAX_BYTES = 512 * 1024;
