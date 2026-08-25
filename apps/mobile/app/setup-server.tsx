import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AUTH_BG } from "../lib/auth-ui";
import {
  COLORS,
  PrimaryButton,
  ScreenHeader,
  SecondaryButton,
  softHaptic,
  useHeaderContentInset,
} from "../lib/design-system";
import { AppSymbol } from "../lib/native";
import {
  bootstrapCommand,
  INSTALL_SCRIPT_COMMAND,
  type ServerHostKind,
  serverHostGuide,
  serverHostOptions,
} from "../lib/server-setup";

export default function SetupServer() {
  const router = useRouter();
  const topInset = useHeaderContentInset();
  const params = useLocalSearchParams<{ kind?: string }>();
  const options = serverHostOptions();
  const [kind, setKind] = useState<ServerHostKind>(() =>
    params.kind === "vps" || params.kind === "box" || params.kind === "local"
      ? params.kind
      : "local",
  );
  // O comando é o caminho de quem tem um terminal; pelo celular ele fica atrás de um toque.
  const [showCommand, setShowCommand] = useState(false);
  // O guia inteiro (para quem, o que precisa, custo) existe, mas atrás de um toque: a
  // tela abre com a pergunta, a escolha e a ação — o resto é leitura de quem quiser.
  const [showGuide, setShowGuide] = useState(false);
  const guide = serverHostGuide(kind);
  // O comando é para a máquina de destino, não para este celular: uma VPS é Linux;
  // um computador da pessoa pode ser Mac ou Linux, e o script descobre qual.
  const command = kind === "local" ? INSTALL_SCRIPT_COMMAND : bootstrapCommand("linux");
  const phoneOnly = kind === "vps" || kind === "box";

  async function copyCommand() {
    await Clipboard.setStringAsync(command);
    softHaptic();
    Alert.alert("Copiado", "Cole no terminal do computador ou no console web da VPS.");
  }

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <StatusBar style="auto" />
      <ScreenHeader onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: topInset }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Onde o Quibt fica ligado?</Text>
        <Text style={styles.subtitle}>
          {phoneOnly
            ? "O app instala tudo lá e você cria a conta aqui mesmo."
            : "Uma máquina que fica ligada. Onde cada bot trabalha você escolhe depois."}
        </Text>

        <View style={styles.segment}>
          {options.map((item) => {
            const active = item.kind === kind;
            return (
              <Pressable
                key={item.kind}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  softHaptic();
                  setKind(item.kind);
                  setShowCommand(false);
                  setShowGuide(false);
                }}
                style={[styles.segmentItem, active && styles.segmentItemActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {item.kind === "local" ? "Computador" : item.kind === "vps" ? "VPS" : "Box"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {kind === "vps" ? (
          <View style={styles.phoneCard}>
            <Text style={styles.phoneTitle}>Pelo celular, agora</Text>
            <Text style={styles.phoneBody}>Você só precisa de três coisas da VPS:</Text>
            <Text style={styles.phoneItem}>• o IP ou endereço (ex.: 203.0.113.10)</Text>
            <Text style={styles.phoneItem}>• o usuário — quase sempre root</Text>
            <Text style={styles.phoneItem}>• a senha ou a chave privada que o provedor deu</Text>
            <PrimaryButton
              label="Instalar por SSH agora"
              onPress={() => router.push("/setup-ssh")}
              style={{ marginTop: 12 }}
            />
            <Text style={styles.phoneHint}>
              A senha e a chave ficam só neste aparelho; o servidor Quibt nunca as recebe.
            </Text>
          </View>
        ) : null}
        {kind === "box" ? (
          <View style={styles.phoneCard}>
            <Text style={styles.phoneTitle}>Pelo celular, agora</Text>
            <Text style={styles.phoneBody}>
              Com a chave de API da Box, o app cria a VM e instala o Quibt nela.
            </Text>
            <PrimaryButton
              label="Instalar na Box agora"
              onPress={() => router.push({ pathname: "/setup-ssh", params: { mode: "box" } })}
              style={{ marginTop: 12 }}
            />
          </View>
        ) : null}

        {showGuide ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              softHaptic();
              setShowGuide(true);
            }}
            style={styles.guideToggle}
          >
            <Text style={styles.guideToggleText}>Como funciona e o que custa</Text>
            <AppSymbol name="chevron.down" size={13} color={COLORS.tertiary} />
          </Pressable>
        )}
        <View style={[styles.guideCard, !showGuide && { display: "none" }]}>
          <Text style={styles.guideHeadline}>{guide.headline}</Text>
          <Text style={styles.guideBody}>{guide.body}</Text>
          <Text style={styles.guideBody}>{guide.what}</Text>
          <Text style={styles.guideSection}>PARA QUEM</Text>
          <Text style={styles.guideItem}>{guide.who}</Text>
          <Text style={styles.guideSection}>O QUE VOCÊ PRECISA</Text>
          {guide.youNeed.map((item) => (
            <Text key={item} style={styles.guideItem}>
              • {item}
            </Text>
          ))}
          <Text style={styles.guideSection}>O QUE FAZER AGORA</Text>
          {guide.steps.map((item, index) => (
            <Text key={item} style={styles.guideItem}>
              {index + 1}. {item}
            </Text>
          ))}
          <Text style={styles.guideBody}>
            <Text style={styles.guideLabel}>Depois do vínculo. </Text>
            {guide.botsLater}
          </Text>
          <Text style={styles.guideBody}>
            <Text style={styles.guideLabel}>Custo. </Text>
            {guide.cost}
          </Text>
          {guide.providerLinks?.map((link) => (
            <Pressable key={link.url} onPress={() => void Linking.openURL(link.url)}>
              <Text style={styles.guideLink}>{link.label}</Text>
            </Pressable>
          ))}
          {guide.signupUrl ? (
            <Pressable onPress={() => void Linking.openURL(guide.signupUrl ?? "")}>
              <Text style={styles.guideLink}>{guide.signupLabel ?? "Abrir o site"}</Text>
            </Pressable>
          ) : null}
          {guide.keyUrl ? (
            <Pressable onPress={() => void Linking.openURL(guide.keyUrl ?? "")}>
              <Text style={styles.guideLink}>{guide.keyLabel ?? "Abrir as chaves"}</Text>
            </Pressable>
          ) : null}
        </View>

        {guide.showBootstrapCommand && phoneOnly && !showCommand ? (
          <SecondaryButton
            label="Prefiro colar o comando eu mesmo"
            onPress={() => setShowCommand(true)}
            style={styles.advancedAction}
          />
        ) : null}
        {guide.showBootstrapCommand && (!phoneOnly || showCommand) ? (
          <View style={styles.commandBlock}>
            <Text style={styles.guideSection}>COMANDO DE INSTALAÇÃO</Text>
            <Text style={styles.commandHint}>
              {kind === "local"
                ? "Rode no terminal deste computador (Mac ou Linux). No Windows, use o app desktop."
                : "Cole no console web da VPS ou por SSH como root."}
            </Text>
            <View style={styles.commandBox}>
              <Text selectable style={styles.commandText}>
                {command}
              </Text>
            </View>
            <PrimaryButton label="Copiar comando" onPress={() => void copyCommand()} />
          </View>
        ) : null}

        <SecondaryButton
          label="Já instalei — conectar"
          onPress={() => router.push("/scan")}
          style={styles.connectAction}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: AUTH_BG },
  content: {
    paddingHorizontal: 22,
    paddingBottom: 36,
    alignItems: "center",
  },
  title: {
    color: COLORS.primary,
    fontSize: 24,
    lineHeight: 29,
    fontWeight: "600",
    letterSpacing: -0.5,
    textAlign: "center",
    marginTop: 12,
  },
  subtitle: {
    color: COLORS.secondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    marginTop: 10,
    maxWidth: 340,
  },
  segment: {
    alignSelf: "stretch",
    marginTop: 20,
    flexDirection: "row",
    padding: 3,
    borderRadius: 12,
    backgroundColor: COLORS.card,
  },
  segmentItem: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: "center" },
  segmentItemActive: {
    backgroundColor: COLORS.background,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { color: COLORS.secondary, fontSize: 14, fontWeight: "600" },
  segmentTextActive: { color: COLORS.primary },
  phoneCard: {
    alignSelf: "stretch",
    marginTop: 18,
    padding: 16,
    borderRadius: 16,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.blue,
    gap: 4,
  },
  phoneTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  phoneBody: { color: COLORS.secondary, fontSize: 14, lineHeight: 20, marginTop: 2 },
  phoneItem: { color: COLORS.primary, fontSize: 14, lineHeight: 21 },
  phoneHint: { color: COLORS.tertiary, fontSize: 12.5, lineHeight: 17, marginTop: 8 },
  guideCard: {
    alignSelf: "stretch",
    marginTop: 22,
    padding: 16,
    borderRadius: 14,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    gap: 6,
  },
  guideToggle: {
    marginTop: 14,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: COLORS.card,
  },
  guideToggleText: { color: COLORS.primary, fontSize: 14, fontWeight: "600" },
  guideHeadline: { color: COLORS.primary, fontSize: 17, fontWeight: "600", lineHeight: 22 },
  guideBody: { color: COLORS.secondary, fontSize: 14, lineHeight: 20 },
  guideSection: {
    color: COLORS.tertiary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginTop: 10,
  },
  guideItem: { color: COLORS.secondary, fontSize: 14, lineHeight: 20 },
  guideLabel: { color: COLORS.primary, fontWeight: "600" },
  guideLink: { color: COLORS.blue, fontSize: 15, fontWeight: "600", marginTop: 8 },
  commandBlock: { alignSelf: "stretch", marginTop: 18 },
  commandHint: { color: COLORS.secondary, fontSize: 13, lineHeight: 18, marginTop: 4 },
  commandBox: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
  },
  commandText: {
    color: COLORS.primary,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  advancedAction: { alignSelf: "stretch", marginTop: 14 },
  connectAction: { alignSelf: "stretch", marginTop: 12 },
});
