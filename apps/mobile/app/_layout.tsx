import { tokens } from "@quibt/ui-tokens";
import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Linking, Platform, useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadApiBase } from "../lib/api";
import { applyAppearance, loadAppearance } from "../lib/appearance";
import { parseBootstrapDeepLink } from "../lib/bootstrap-pairing";
import { QuibtAppIcon } from "../lib/brand";
import { applyConnectLink } from "../lib/connect";
import { deepLinkIs, parseAppDeepLink } from "../lib/deep-link";
import { iconFonts } from "../lib/icon-font";
import { NativeSheetHost } from "../lib/native";
import { preloadArtwork } from "../lib/preload-artwork";
import {
  configureNotificationPresentation,
  ensureNotificationChannel,
  notificationData,
  notificationTarget,
} from "../lib/push";
import { LOCAL_STARTUP_TIMEOUT_MS, runStartupTask } from "../lib/startup";

/** O tema de navegação nas cores do produto: página clara, tinta neutra, azul de ação. */
const QUIBT_NAV_THEME = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: tokens.accent,
    background: tokens.page,
    card: tokens.page,
    text: tokens.ink,
    border: tokens.hairline,
  },
};

/** O mesmo tema no escuro: o fundo das transições de rota não pode piscar branco. */
const QUIBT_NAV_THEME_DARK = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: tokens.accent,
    background: "#0E0E10",
    card: "#0E0E10",
    text: "#F2F2F4",
    border: "#2E2E35",
  },
};

export default function Layout() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  // The .ios module is empty because iOS renders SF Symbols natively.
  const [fontsLoaded, fontError] = useFonts(iconFonts);

  const scheme = useColorScheme();

  useEffect(() => {
    // A escolha de aparência da pessoa entra antes da primeira tela pintar.
    void loadAppearance()
      .then(applyAppearance)
      .catch(() => undefined);
    void runStartupTask(() => loadApiBase(), LOCAL_STARTUP_TIMEOUT_MS).then(() => setReady(true));
    // Sem esperar: as telas usam o que já chegou e o resto entra no cache em segundo plano.
    void preloadArtwork().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) return;
    const timer = setTimeout(() => setFontsTimedOut(true), LOCAL_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [fontError, fontsLoaded]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    configureNotificationPresentation();
    void ensureNotificationChannel().catch(() => undefined);
    let active = true;
    const open = (response: Notifications.NotificationResponse) => {
      const target = notificationTarget(notificationData(response));
      if (target) router.push(target);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync()
      .then(async (response) => {
        if (!active || !response) return;
        open(response);
        await Notifications.clearLastNotificationResponseAsync();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [router]);

  useEffect(() => {
    function open(url: string) {
      const parsed = parseAppDeepLink(url);
      if (!parsed) return;
      const { path, searchParams } = parsed;
      if (deepLinkIs(path, "billing")) {
        router.push("/billing");
        return;
      }
      if (deepLinkIs(path, "plugins/callback", "plugins")) {
        router.push({
          pathname: "/plugins",
          params: { connectionId: searchParams.get("connectionId") ?? "" },
        });
        return;
      }
      if (deepLinkIs(path, "bootstrap")) {
        const bootstrap = parseBootstrapDeepLink(url);
        if (!bootstrap) return;
        router.push({
          pathname: "/pair-installation",
          params: { api: bootstrap.api, token: bootstrap.token },
        });
        return;
      }
      if (deepLinkIs(path, "connect")) {
        // Ler o QR pela câmera do iPhone cai aqui. Se o link trouxe o código de
        // emparelhamento, o app já entra; senão, pede o código no servidor certo.
        void applyConnectLink(url).then((result) => {
          if (result.ok && result.signedIn) {
            router.replace("/");
            return;
          }
          router.push({
            pathname: "/enter-code",
            params: { api: searchParams.get("api") ?? "" },
          });
        });
      }
    }
    const sub = Linking.addEventListener("url", ({ url }) => open(url));
    void Linking.getInitialURL().then((url) => {
      if (url) open(url);
    });
    return () => sub.remove();
  }, [router]);

  if (!ready || (!fontsLoaded && !fontError && !fontsTimedOut)) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: scheme === "dark" ? "#0E0E10" : tokens.page,
        }}
      >
        <QuibtAppIcon size={72} />
      </View>
    );
  }

  return (
    /*
     * A raiz do gesture-handler precisa envolver o app inteiro: sem ela o arrastar das
     * linhas da caixa de entrada não recebe o toque, e no Android nem chega a existir.
     */
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={scheme === "dark" ? QUIBT_NAV_THEME_DARK : QUIBT_NAV_THEME}>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: scheme === "dark" ? "#0E0E10" : tokens.page },
            headerTintColor: scheme === "dark" ? "#F2F2F4" : tokens.ink,
            headerShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="account" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          <Stack.Screen name="scan" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen name="server" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen name="setup-server" options={{ headerShown: false }} />
          <Stack.Screen name="setup-ssh" options={{ headerShown: false }} />
          <Stack.Screen name="pair-installation" options={{ headerShown: false }} />
          <Stack.Screen name="sign-up" options={{ headerShown: false }} />
          <Stack.Screen name="enter-code" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="machine-settings" options={{ headerShown: false }} />
          <Stack.Screen name="model" options={{ headerShown: false }} />
          <Stack.Screen name="billing" options={{ headerShown: false }} />
          <Stack.Screen name="plugins" options={{ headerShown: false }} />
          <Stack.Screen name="new" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen name="thread" options={{ headerShown: false }} />
          <Stack.Screen name="computer" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
          <Stack.Screen name="new-group" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen name="group-settings" options={{ headerShown: false }} />
        </Stack>
        <NativeSheetHost />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
