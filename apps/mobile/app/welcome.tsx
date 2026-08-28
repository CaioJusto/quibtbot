import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  currentApiBase,
  defaultApiBase,
  displayApiHost,
  loadSessionToken,
  probeApiBase,
} from "../lib/api";
import { AUTH_BG } from "../lib/auth-ui";
import { hasEnrollmentToken } from "../lib/bootstrap-pairing";
import { QuibtAppIcon, QuibtTeam } from "../lib/brand";
import { COLORS, PrimaryButton, softHaptic } from "../lib/design-system";
import { AppSymbol, type AppSymbolName } from "../lib/native";
import {
  hasUsableStartupSession,
  LOCAL_STARTUP_TIMEOUT_MS,
  runStartupTask,
  STARTUP_UNAVAILABLE_PARAM,
} from "../lib/startup";

type Reach = "checking" | "online" | "offline";

/**
 * Primeira tela antes de qualquer cadastro. Uma frase, um botão e três caminhos curtos;
 * o que cada caminho faz se explica na tela seguinte, não aqui.
 *
 * - já usa o Quibt num computador → lê o QR que o app do computador mostra;
 * - só tem o celular → escolhe Box ou VPS, o app instala e a conta é criada aqui mesmo;
 * - quer instalar num computador → recebe o passo a passo.
 *
 * Ler o QR é sempre o primeiro caminho. Instalação, endereço manual e criação de
 * conta aparecem depois, como alternativas — nunca competem com a ação principal.
 */
export default function Welcome() {
  const router = useRouter();
  const { startup } = useLocalSearchParams<{ startup?: string }>();
  const connectionUnavailable = startup === STARTUP_UNAVAILABLE_PARAM;
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [reach, setReach] = useState<Reach>("checking");
  const [bootstrapClaim, setBootstrapClaim] = useState(false);

  useEffect(() => {
    let active = true;
    void runStartupTask(
      () => Promise.all([loadSessionToken(), hasEnrollmentToken()]),
      LOCAL_STARTUP_TIMEOUT_MS,
    ).then((result) => {
      if (!active) return;
      setHasSession(
        hasUsableStartupSession(result.ok ? { ok: true, value: result.value[0] } : result),
      );
      setBootstrapClaim(result.ok && result.value[1]);
      setApiBase(currentApiBase());
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    setReach("checking");
    void probeApiBase(apiBase)
      .then((result) => {
        if (active) setReach(result.ok ? "online" : "offline");
      })
      .catch(() => {
        if (active) setReach("offline");
      });
    return () => {
      active = false;
    };
  }, [ready, apiBase]);

  if (!ready) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <QuibtAppIcon size={72} />
      </View>
    );
  }
  if (hasSession && !connectionUnavailable) return <Redirect href="/" />;

  const connected = apiBase !== defaultApiBase();
  const online = reach === "online";
  const canSignUp = online || bootstrapClaim;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="auto" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <QuibtTeam width={232} />
          <Text style={styles.title}>Seu time de bots.</Text>
          <Text style={styles.subtitle}>
            Eles trabalham numa máquina sua. Este app é o controle remoto.
          </Text>
        </View>

        {connectionUnavailable ? (
          <View style={styles.connectionNotice}>
            <AppSymbol name="wifi.exclamationmark" size={18} color={COLORS.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.connectionNoticeTitle}>Seu Quibt não respondeu</Text>
              <Text style={styles.connectionNoticeText}>
                Confira a internet ou o servidor e tente novamente.
              </Text>
            </View>
          </View>
        ) : null}

        {connected && online ? (
          <View style={styles.readyPill}>
            <View style={styles.dot} />
            <Text style={styles.readyText} numberOfLines={1}>
              Conectado a {displayApiHost(apiBase)}
            </Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => router.push("/server")}
            >
              <Text style={styles.readyChange}>Trocar</Text>
            </Pressable>
          </View>
        ) : null}

        {connectionUnavailable && hasSession ? (
          <View style={styles.actions}>
            <PrimaryButton
              label="Tentar novamente"
              onPress={() => router.replace("/")}
              style={styles.primary}
            />
            <Pressable
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => router.push("/server")}
              style={styles.secondaryLink}
            >
              <Text style={styles.link}>Trocar servidor</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <PrimaryButton
              label="Ler QR code"
              onPress={() => router.push("/scan")}
              style={styles.primary}
            />
            <Pressable
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => router.push("/enter-code")}
              style={styles.secondaryLink}
            >
              <Text style={styles.link}>Tenho um código</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.pathsLabel}>Outras opções</Text>
        <View style={styles.paths}>
          {canSignUp ? (
            <PathRow
              icon="person.badge.plus"
              title="Criar minha conta"
              hint={`No computador ${displayApiHost(apiBase)}`}
              onPress={() => router.push("/sign-up")}
            />
          ) : null}
          <PathRow
            icon="desktopcomputer"
            title="Digitar o endereço do meu Quibt"
            hint="Se você já sabe a URL"
            onPress={() => router.push("/server")}
          />
          <PathRow
            icon="cloud.fill"
            title="Só tenho o celular"
            hint="Instalar no Box ou numa VPS"
            onPress={() =>
              router.push({
                pathname: "/setup-server",
                params: { kind: "box" },
              })
            }
          />
          <PathRow
            icon="laptopcomputer"
            title="Instalar num computador meu"
            hint="Mac, Windows ou Linux"
            onPress={() =>
              router.push({
                pathname: "/setup-server",
                params: { kind: "local" },
              })
            }
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PathRow({
  icon,
  title,
  hint,
  onPress,
}: {
  icon: AppSymbolName;
  title: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        softHaptic();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <AppSymbol name={icon} size={18} color={COLORS.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <AppSymbol name="chevron.right" size={14} color={COLORS.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: AUTH_BG },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 28,
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
  },
  hero: { alignItems: "center" },
  title: {
    color: COLORS.primary,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: "600",
    letterSpacing: -1.2,
    textAlign: "center",
    marginTop: 6,
  },
  subtitle: {
    color: COLORS.secondary,
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
    marginTop: 10,
    maxWidth: 300,
  },
  readyPill: {
    alignSelf: "center",
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: COLORS.card,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.green },
  readyText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: 220,
  },
  readyChange: {
    color: COLORS.blue,
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 4,
  },
  connectionNotice: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: COLORS.card,
    borderColor: COLORS.separator,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  connectionNoticeTitle: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  connectionNoticeText: {
    color: COLORS.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  actions: { alignItems: "center", marginTop: 26 },
  primary: { alignSelf: "stretch" },
  secondaryLink: { paddingVertical: 14 },
  link: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },
  paths: {
    marginTop: 7,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
  },
  pathsLabel: {
    color: COLORS.tertiary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.7,
    marginTop: 14,
    paddingHorizontal: 2,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.separator,
  },
  rowPressed: { backgroundColor: COLORS.card },
  rowIcon: {
    width: 26,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },
  rowHint: { color: COLORS.secondary, fontSize: 13, marginTop: 1 },
});
