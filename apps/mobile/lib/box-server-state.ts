import * as SecureStore from "expo-secure-store";
import { isValidBoxId } from "./box-install-transport.js";

const BOX_SERVER_ID_KEY = "quibt.box.server-id";

export async function loadBoxServerId(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(BOX_SERVER_ID_KEY);
    return value && isValidBoxId(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveBoxServerId(boxId: string): Promise<void> {
  if (!isValidBoxId(boxId)) return;
  await SecureStore.setItemAsync(BOX_SERVER_ID_KEY, boxId).catch(() => undefined);
}

export async function forgetBoxServerId(): Promise<void> {
  await SecureStore.deleteItemAsync(BOX_SERVER_ID_KEY).catch(() => undefined);
}
