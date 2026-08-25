import * as SecureStore from "expo-secure-store";
import type { DemoBotSettings } from "./demo-inbox";

const DEMO_SETTINGS_KEY = "quibt.demo_inbox_settings.v1";

let writeQueue: Promise<void> = Promise.resolve();

export async function loadDemoBotSettings(): Promise<Record<string, DemoBotSettings>> {
  try {
    const stored = await SecureStore.getItemAsync(DEMO_SETTINGS_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, DemoBotSettings>) : {};
  } catch {
    return {};
  }
}

export function saveDemoBotSettings(botId: string, patch: DemoBotSettings): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const current = await loadDemoBotSettings();
    const next = {
      ...current,
      [botId]: { ...(current[botId] ?? {}), ...patch },
    };
    try {
      await SecureStore.setItemAsync(DEMO_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Demo data is best-effort in hosts that do not expose SecureStore.
    }
  });
  return writeQueue;
}
