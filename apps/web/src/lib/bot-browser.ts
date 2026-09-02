import { desktopBridge, type QuibtDesktop } from "./desktop.js";

export function desktopComputerSurface(desktop?: QuibtDesktop | null): "embedded" | "novnc" {
  return desktop ? "embedded" : "novnc";
}

export function normalizeTypedBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.protocol === "http:" && parsed.hostname === "") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function takeoverRequested(input: {
  runStatus?: string | null;
  waitingTakeover?: boolean | null;
}): boolean {
  return input.runStatus === "waiting_takeover" || input.waitingTakeover === true;
}

export function desktopBotBrowser() {
  return desktopBridge()?.botBrowser;
}
