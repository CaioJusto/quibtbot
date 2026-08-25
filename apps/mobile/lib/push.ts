import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { loadSessionToken, rpc } from "./api";

const PUSH_TOKEN_KEY = "quibt.expo_push_token";
let presentationConfigured = false;
/** "<session>:<push token>" already sent this app session; skips the round-trip on refocus. */
let registeredThisSession: string | null = null;

export function notificationTarget(data: Record<string, unknown> | undefined) {
  const botId = data?.botId;
  if (typeof botId !== "string" || !botId.trim() || botId.length > 128) return null;
  return {
    pathname: "/thread" as const,
    params: { botId, name: typeof data?.botName === "string" ? data.botName : "Conversa" },
  };
}

export function configureNotificationPresentation() {
  if (presentationConfigured) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    presentationConfigured = true;
  } catch {
    // Notifications are unavailable in Expo web and some preview hosts.
  }
}

export async function ensureNotificationChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "Atualizações dos bots",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function registerPushToken() {
  try {
    configureNotificationPresentation();
    await ensureNotificationChannel();
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return false;
    const projectId =
      process.env.EXPO_PUBLIC_PROJECT_ID ??
      Constants.easConfig?.projectId ??
      Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return false;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return false;
    const registration = `${await loadSessionToken()}:${token}`;
    if (registeredThisSession === registration) return true;
    const previous = await SecureStore.getItemAsync(PUSH_TOKEN_KEY).catch(() => null);
    await rpc("notifications/registerPush", { token });
    if (previous && previous !== token) {
      await rpc("notifications/unregisterPush", { token: previous }).catch(() => undefined);
    }
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
    registeredThisSession = registration;
    return true;
  } catch {
    // Permission, Expo Go, credentials, and temporary network failures are retried
    // whenever the signed-in home screen is focused again.
    return false;
  }
}

export async function unregisterPushToken() {
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY).catch(() => null);
  if (!token) return;
  await rpc("notifications/unregisterPush", { token });
  registeredThisSession = null;
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY).catch(() => undefined);
}

export function notificationData(response: Notifications.NotificationResponse) {
  return response.notification.request.content.data;
}
