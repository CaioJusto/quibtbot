import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useRef, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { displayApiHost } from "../lib/api";
import { parseBootstrapDeepLink } from "../lib/bootstrap-pairing";
import { applyConnectLink, connectFailureMessage } from "../lib/connect";
import { COLORS, PrimaryButton, SecondaryButton, softHaptic } from "../lib/design-system";
import { AppSymbol } from "../lib/native";

/**
 * Lê o QR que o computador mostra em Conta → Conectar o celular. O QR carrega o endereço
 * daquele servidor: depois de ler, o app passa a falar com ele e o login é o daquela
 * instalação. Sem o QR, o app fala com o servidor padrão.
 */
export default function Scan() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{
    api: string;
    signedIn: boolean;
    name?: string;
  } | null>(null);
  const handling = useRef(false);

  async function handle(data: string) {
    if (handling.current) return;
    handling.current = true;
    setError(null);

    const bootstrap = parseBootstrapDeepLink(data);
    if (bootstrap) {
      softHaptic();
      router.push({
        pathname: "/pair-installation",
        params: { api: bootstrap.api, token: bootstrap.token },
      });
      return;
    }

    const result = await applyConnectLink(data);
    if (!result.ok) {
      setError(connectFailureMessage(result, Platform.OS));
      handling.current = false;
      return;
    }
    softHaptic();
    setConnected({
      api: result.api,
      signedIn: result.signedIn,
      name: result.name,
    });
  }

  if (!permission) {
    return <View style={styles.page} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar style="auto" />
        <View style={styles.centered}>
          <View style={styles.badge}>
            <AppSymbol name="qrcode.viewfinder" size={30} color={COLORS.blue} />
          </View>
          <Text style={styles.title}>Ler o QR do computador</Text>
          <Text style={styles.body}>
            Para ler o código precisamos da câmera. Nada é gravado: a leitura só descobre o endereço
            do seu servidor.
          </Text>
          <PrimaryButton
            label="Permitir a câmera"
            onPress={() => {
              void requestPermission().then((next) => {
                if (!next.granted && !next.canAskAgain) void Linking.openSettings();
              });
            }}
            style={{ alignSelf: "stretch", marginTop: 26 }}
          />
          <SecondaryButton
            label="Digitar o endereço"
            onPress={() => router.push("/server")}
            style={{ alignSelf: "stretch", marginTop: 10 }}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (connected) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar style="auto" />
        <View style={styles.centered}>
          <View style={[styles.badge, { backgroundColor: "#E4EFE6" }]}>
            <AppSymbol name="checkmark.circle.fill" size={30} color={COLORS.green} />
          </View>
          <Text style={styles.title}>
            {connected.signedIn ? "Tudo pronto" : "Computador conectado"}
          </Text>
          <Text style={styles.body}>
            {connected.signedIn
              ? `Você entrou${connected.name ? ` como ${connected.name}` : ""} no computador ${displayApiHost(connected.api)}.`
              : `Este app agora fala com ${displayApiHost(connected.api)}. No computador, abra Conta → Conectar o celular e toque em liberar: ele mostra um código de seis caracteres.`}
          </Text>
          {/*
            Ler o QR já resolveu o difícil, que é achar o servidor. Mandar para o login
            aqui era pedir e-mail e senha de quem está com o computador logado do lado —
            o código curto é o caminho curto, e é ele que aparece primeiro.
          */}
          <PrimaryButton
            label={connected.signedIn ? "Abrir meus bots" : "Digitar o código"}
            onPress={() => router.replace(connected.signedIn ? "/" : "/enter-code")}
            style={{ alignSelf: "stretch", marginTop: 26 }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraPage}>
      <StatusBar style="light" />
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => void handle(data)}
      />
      <SafeAreaView style={styles.cameraChrome}>
        <View style={styles.cameraTop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fechar"
            hitSlop={10}
            onPress={() => router.back()}
            style={styles.closeButton}
          >
            <AppSymbol name="xmark" size={17} color="#FFFFFF" />
          </Pressable>
        </View>
        <View style={styles.reticleWrap}>
          <View style={styles.reticle} />
        </View>
        <View style={styles.cameraFoot}>
          <Text style={styles.cameraTitle}>Aponte para o QR do computador</Text>
          <Text style={styles.cameraBody}>
            No computador, abra Conta → Conectar o celular. O código aparece na tela.
          </Text>
          {error ? <Text style={styles.cameraError}>{error}</Text> : null}
          {error && Platform.OS === "ios" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void Linking.openSettings()}
              style={{ paddingTop: 12, paddingBottom: 4 }}
            >
              <Text style={styles.cameraSettings}>Abrir Ajustes do iPhone</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              handling.current = false;
              setError(null);
              router.push("/server");
            }}
            style={{ paddingVertical: 14 }}
          >
            <Text style={styles.cameraLink}>Digitar o endereço no lugar disso</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
  badge: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(60, 130, 246, 0.12)",
    marginBottom: 22,
  },
  title: {
    color: COLORS.primary,
    fontSize: 27,
    lineHeight: 32,
    fontWeight: "600",
    letterSpacing: -0.7,
  },
  body: {
    color: COLORS.secondary,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  cameraPage: { flex: 1, backgroundColor: "#000000" },
  cameraChrome: { flex: 1, justifyContent: "space-between" },
  cameraTop: { paddingHorizontal: 18, paddingTop: 8, alignItems: "flex-start" },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
  },
  reticleWrap: { alignItems: "center" },
  reticle: {
    width: 238,
    height: 238,
    borderRadius: 26,
    borderWidth: 3,
    borderColor: "rgba(255, 255, 255, 0.92)",
  },
  cameraFoot: {
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 18,
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  cameraTitle: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "600",
    textAlign: "center",
  },
  cameraBody: {
    color: "rgba(255, 255, 255, 0.76)",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 7,
  },
  cameraError: {
    color: "#FFB4B4",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 12,
  },
  cameraLink: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 6,
  },
  cameraSettings: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
});
