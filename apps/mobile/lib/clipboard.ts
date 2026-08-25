import * as Clipboard from "expo-clipboard";

/** Device clipboard text, or empty when the OS denies access / has nothing copied. */
export async function readClipboardText(): Promise<string> {
  const text = await Clipboard.getStringAsync().catch(() => "");
  return text.trim() ? text : "";
}

export async function writeClipboardText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}
