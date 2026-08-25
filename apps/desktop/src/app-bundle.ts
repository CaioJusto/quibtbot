/**
 * Do executável ao pacote `.app`: é o pacote que vai para o Lixo na desinstalação,
 * não o binário dentro dele. Fora do macOS não há pacote — o instalador do sistema
 * (Windows) ou o AppImage são removidos pelo usuário.
 */
export function appBundlePath(
  exePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  const marker = exePath.indexOf(".app/Contents/");
  return marker > 0 ? exePath.slice(0, marker + ".app".length) : null;
}
