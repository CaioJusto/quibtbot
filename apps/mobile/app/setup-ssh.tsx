import { normalizeBoxHostedUrl } from "@quibt/core";
import type { InstallerEvent } from "@quibt/installer";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AUTH_BG, AUTH_FIELD_TEXT } from "../lib/auth-ui";
import { claimInstallation } from "../lib/bootstrap-pairing";
import {
  createBoxInstallTransport,
  runBoxRemoteInstall,
  runBoxRemoteUpdate,
} from "../lib/box-install-transport";
import { loadBoxServerId, saveBoxServerId } from "../lib/box-server-state";
import {
  COLORS,
  METRICS,
  PrimaryButton,
  RADII,
  ScreenHeader,
  SecondaryButton,
  softHaptic,
  TEXT_SIZES,
  useHeaderContentInset,
} from "../lib/design-system";
import {
  loadInfrastructureCredential,
  parseSshCredentialHostId,
  saveInfrastructureCredential,
} from "../lib/infrastructure-secrets";
import {
  runVerifiedRemoteInstall,
  runVerifiedRemoteUpdate,
  type SshInstallTransport,
} from "../lib/remote-installer";
import { sshSetupErrorMessage } from "../lib/ssh-setup-errors";
import { createSshInstallTransport, sshTransportSupported } from "../lib/ssh-transport";

type SetupMode = "ssh" | "box";
type SetupOperation = "install" | "update";
type SetupStage = "form" | "inspect" | "confirm-fingerprint" | "installing" | "done" | "error";

function hostId(hostname: string, port: string, username: string) {
  return `${username.trim()}@${hostname.trim()}:${port.trim() || "22"}`;
}

function stageLabel(stage: SetupStage, operation: SetupOperation): string {
  switch (stage) {
    case "form":
      return operation === "update" ? "Atualizar servidor" : "Dados do servidor";
    case "inspect":
      return "Lendo impressão digital";
    case "confirm-fingerprint":
      return "Confirme a impressão digital";
    case "installing":
      return operation === "update" ? "Atualizando Quibt" : "Instalando Quibt";
    case "done":
      return operation === "update" ? "Servidor atualizado" : "Pronto para conectar";
    case "error":
      return "Algo deu errado";
  }
}

export default function SetupSshScreen() {
  const router = useRouter();
  const topInset = useHeaderContentInset();
  const params = useLocalSearchParams<{ mode?: string; action?: string; hostId?: string }>();
  const mode: SetupMode = params.mode === "box" ? "box" : "ssh";
  const savedTarget =
    params.action === "update" ? parseSshCredentialHostId(params.hostId ?? "") : null;
  const operation: SetupOperation = params.action === "update" ? "update" : "install";

  const [stage, setStage] = useState<SetupStage>("form");
  const [host, setHost] = useState(savedTarget?.hostname ?? "");
  const [port, setPort] = useState(String(savedTarget?.port ?? 22));
  const [username, setUsername] = useState(savedTarget?.username ?? "root");
  const [authMode, setAuthMode] = useState<"password" | "privateKey">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [boxApiKey, setBoxApiKey] = useState("");
  const [expectedFingerprint, setExpectedFingerprint] = useState("");
  const [inspectedFingerprint, setInspectedFingerprint] = useState("");
  const [inspectedAlgorithm, setInspectedAlgorithm] = useState("");
  const [saveCredential, setSaveCredential] = useState(true);
  const [events, setEvents] = useState<InstallerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultCode, setResultCode] = useState<string | null>(null);
  const [updatedRelease, setUpdatedRelease] = useState<string | null>(null);
  const [previousRelease, setPreviousRelease] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  /**
   * O instalador devolve URL + código de oito caracteres. Antes a pessoa tinha que
   * anotar os dois e digitar em outra tela; agora o app valida e abre o cadastro.
   */
  async function claimAndSignUp() {
    if (!resultUrl || !resultCode) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const claimed = await claimInstallation(resultUrl, resultCode);
      if (!claimed.ok) {
        setClaimError(claimed.error);
        return;
      }
      router.replace("/sign-up");
    } finally {
      setClaiming(false);
    }
  }
  const [busy, setBusy] = useState(false);
  const transportRef = useRef<SshInstallTransport | null>(null);

  const credentialHostId = useMemo(() => {
    if (mode === "box") return "box.ascii.dev";
    return hostId(host, port, username);
  }, [host, mode, port, username]);

  async function inspectFingerprint() {
    if (mode === "box") {
      setStage("installing");
      await startInstall("box-api");
      return;
    }
    if (!host.trim() || !username.trim()) {
      setError("Informe host e usuário.");
      setStage("error");
      return;
    }
    if (!sshTransportSupported) {
      setError("Instalação SSH remota só está disponível no app iOS ou Android.");
      setStage("error");
      return;
    }

    setBusy(true);
    setError(null);
    setStage("inspect");
    try {
      const transport = createSshInstallTransport({
        hostname: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
      });
      transportRef.current = transport;
      const identity = await transport.inspectIdentity();
      setInspectedFingerprint(identity.fingerprint);
      setInspectedAlgorithm(identity.algorithm);
      setExpectedFingerprint(identity.fingerprint);
      setStage("confirm-fingerprint");
    } catch (err) {
      setError(sshSetupErrorMessage(err, { host: host.trim(), port: Number(port) || 22 }));
      setStage("error");
    } finally {
      setBusy(false);
    }
  }

  async function startInstall(confirmedFingerprint: string) {
    setBusy(true);
    setError(null);
    setEvents([]);
    setStage("installing");

    try {
      if (mode === "box") {
        const savedBoxId = await loadBoxServerId();
        const transport = createBoxInstallTransport({
          boxId: savedBoxId ?? undefined,
          onBoxAllocated: saveBoxServerId,
          loadApiKey: async () => {
            if (boxApiKey.trim()) return boxApiKey.trim();
            const stored = await loadInfrastructureCredential("box.ascii.dev");
            if (stored.state === "ok" && stored.credential.type === "boxApiKey") {
              return stored.credential.apiKey;
            }
            throw new Error("Informe a chave Box ou salve uma credencial primeiro.");
          },
        });
        if (operation === "update") {
          const result = await runBoxRemoteUpdate(transport, (event) => {
            setEvents((current) => [...current, event]);
          });
          if (!result.ok) throw new Error(result.error ?? "Atualização da Box falhou.");
          setUpdatedRelease(result.release ?? null);
          setPreviousRelease(result.previousRelease ?? null);
          setBackupPath(result.backupPath ?? null);
          setStage("done");
          return;
        }
        const result = await runBoxRemoteInstall(transport, (event) => {
          setEvents((current) => [...current, event]);
        });
        if (!result.ok) throw new Error(result.error ?? "Instalação Box falhou.");
        const boxPublicUrl = normalizeBoxHostedUrl(result.url ?? "");
        if (!boxPublicUrl) {
          throw new Error(
            "A Box não devolveu um endereço HTTPS público válido. A máquina foi preservada.",
          );
        }
        if (saveCredential && boxApiKey.trim()) {
          await saveInfrastructureCredential("box.ascii.dev", {
            type: "boxApiKey",
            label: "Box servidor",
            apiKey: boxApiKey.trim(),
          });
        }
        setResultUrl(boxPublicUrl);
        setResultCode(result.pairing?.code ?? null);
        setStage("done");
        return;
      }

      const fingerprint = confirmedFingerprint.trim();
      if (!fingerprint) {
        throw new Error("A impressão digital esperada é obrigatória.");
      }

      const transport =
        transportRef.current ??
        createSshInstallTransport({
          hostname: host.trim(),
          port: Number(port) || 22,
          username: username.trim(),
        });

      if (operation === "update") {
        const storedHostId = params.hostId ?? credentialHostId;
        transport.attachCredential(async () => {
          const stored = await loadInfrastructureCredential(storedHostId);
          if (stored.state !== "ok" || stored.credential.type === "boxApiKey") {
            throw new Error(
              "A credencial salva não está mais disponível. Informe a senha ou chave novamente.",
            );
          }
          if (stored.credential.type === "password") {
            return { type: "password", password: stored.credential.password };
          }
          return {
            type: "privateKey",
            privateKey: stored.credential.privateKey,
            ...(stored.credential.passphrase ? { passphrase: stored.credential.passphrase } : {}),
          };
        });

        const result = await runVerifiedRemoteUpdate(transport, {
          expectedFingerprint: fingerprint,
          onEvent: (event) => setEvents((current) => [...current, event]),
        });
        if (!result.ok) throw new Error(result.error ?? "Atualização SSH falhou.");
        setUpdatedRelease(result.release ?? null);
        setPreviousRelease(result.previousRelease ?? null);
        setBackupPath(result.backupPath ?? null);
        setStage("done");
        return;
      }

      transport.attachCredential(async () => {
        if (authMode === "password") {
          if (!password.trim()) throw new Error("Informe a senha SSH.");
          return { type: "password", password: password.trim() };
        }
        if (!privateKey.trim()) throw new Error("Informe a chave privada.");
        return {
          type: "privateKey",
          privateKey: privateKey.trim(),
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        };
      });

      const result = await runVerifiedRemoteInstall(transport, {
        expectedFingerprint: fingerprint,
        onEvent: (event) => setEvents((current) => [...current, event]),
      });

      if (!result.ok) throw new Error(result.error ?? "Instalação SSH falhou.");

      if (saveCredential) {
        const label = credentialHostId;
        if (authMode === "password") {
          await saveInfrastructureCredential(credentialHostId, {
            type: "password",
            label,
            password: password.trim(),
          });
        } else {
          await saveInfrastructureCredential(credentialHostId, {
            type: "privateKey",
            label,
            privateKey: privateKey.trim(),
            ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
          });
        }
      }

      setResultUrl(result.url ?? null);
      setResultCode(result.pairing?.code ?? null);
      setStage("done");
    } catch (err) {
      setError(sshSetupErrorMessage(err, { host: host.trim(), port: Number(port) || 22 }));
      setStage("error");
    } finally {
      setBusy(false);
      transportRef.current = null;
    }
  }

  function resetToForm() {
    setStage("form");
    setError(null);
    setEvents([]);
    setResultUrl(null);
    setResultCode(null);
    setUpdatedRelease(null);
    setPreviousRelease(null);
    setBackupPath(null);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <StatusBar style="auto" />
      <ScreenHeader
        onBack={() => router.back()}
        title={
          operation === "update"
            ? "Atualizar servidor"
            : mode === "box"
              ? "Instalar no Box"
              : "Instalar na VPS"
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: topInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.stage}>{stageLabel(stage, operation)}</Text>

        {stage === "form" ? (
          <View style={styles.card}>
            {mode === "box" ? (
              operation === "update" ? (
                <>
                  <Text style={styles.label}>Box salva neste iPhone</Text>
                  <Text style={styles.hint}>
                    O Face ID libera a chave Box já salva somente neste aparelho. A máquina, os bots
                    e os dados serão preservados; antes da troca de versão, o Quibt cria um backup
                    para rollback.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.label}>Chave da API Box</Text>
                  <TextInput
                    value={boxApiKey}
                    onChangeText={setBoxApiKey}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="box_live_..."
                    placeholderTextColor={COLORS.tertiary}
                    style={AUTH_FIELD_TEXT}
                  />
                  <Text style={styles.hint}>
                    Use somente uma chave criada em box.ascii.dev — não é a chave da Hetzner. Ela
                    fica no SecureStore deste aparelho e não é enviada para a API Quibt. No trial, o
                    servidor de teste fica ligado por até 2 horas por vez.
                  </Text>
                </>
              )
            ) : operation === "update" ? (
              <>
                <Text style={styles.label}>Servidor salvo</Text>
                <Text selectable style={styles.mono}>
                  {credentialHostId}
                </Text>
                <Text style={styles.hint}>
                  Primeiro conferimos a impressão digital SSH. Depois o Face ID libera a credencial
                  somente para criar o backup e atualizar esta VPS.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.label}>Host</Text>
                <TextInput
                  value={host}
                  onChangeText={setHost}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="203.0.113.10"
                  placeholderTextColor={COLORS.tertiary}
                  style={AUTH_FIELD_TEXT}
                />
                <Text style={styles.label}>Porta</Text>
                <TextInput
                  value={port}
                  onChangeText={setPort}
                  keyboardType="number-pad"
                  placeholder="22"
                  placeholderTextColor={COLORS.tertiary}
                  style={AUTH_FIELD_TEXT}
                />
                <Text style={styles.label}>Usuário</Text>
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="root"
                  placeholderTextColor={COLORS.tertiary}
                  style={AUTH_FIELD_TEXT}
                />
                <View style={styles.modeRow}>
                  <Pressable
                    onPress={() => setAuthMode("password")}
                    style={[styles.modeChip, authMode === "password" && styles.modeChipActive]}
                  >
                    <Text style={styles.modeChipText}>Senha</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setAuthMode("privateKey")}
                    style={[styles.modeChip, authMode === "privateKey" && styles.modeChipActive]}
                  >
                    <Text style={styles.modeChipText}>Chave privada</Text>
                  </Pressable>
                </View>
                {authMode === "password" ? (
                  <>
                    <Text style={styles.label}>Senha SSH</Text>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={AUTH_FIELD_TEXT}
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.label}>Chave privada</Text>
                    <TextInput
                      value={privateKey}
                      onChangeText={setPrivateKey}
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[AUTH_FIELD_TEXT, styles.multiline]}
                    />
                    <Text style={styles.label}>Passphrase (opcional)</Text>
                    <TextInput
                      value={passphrase}
                      onChangeText={setPassphrase}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={AUTH_FIELD_TEXT}
                    />
                  </>
                )}
              </>
            )}

            {operation === "install" ? (
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Salvar credencial neste aparelho</Text>
                <Switch value={saveCredential} onValueChange={setSaveCredential} />
              </View>
            ) : null}

            <PrimaryButton
              label={
                mode === "box"
                  ? operation === "update"
                    ? "Atualizar minha Box"
                    : "Instalar no Box"
                  : "Ler impressão digital"
              }
              onPress={() => {
                softHaptic();
                void inspectFingerprint();
              }}
              disabled={busy}
            />
          </View>
        ) : null}

        {stage === "confirm-fingerprint" ? (
          <View style={styles.card}>
            <Text style={styles.hint}>
              Confira a impressão digital SHA256 antes de continuar. A senha ou chave só são usadas
              depois desta confirmação.
            </Text>
            <Text style={styles.label}>Algoritmo</Text>
            <Text style={styles.mono}>{inspectedAlgorithm}</Text>
            <Text style={styles.label}>Impressão lida</Text>
            <Text selectable style={styles.mono}>
              {inspectedFingerprint}
            </Text>
            <Text style={styles.label}>Impressão esperada</Text>
            <TextInput
              value={expectedFingerprint}
              onChangeText={setExpectedFingerprint}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="SHA256:..."
              placeholderTextColor={COLORS.tertiary}
              style={[AUTH_FIELD_TEXT, styles.monoInput]}
            />
            <PrimaryButton
              label={operation === "update" ? "Verificar e atualizar" : "Verificar e instalar"}
              onPress={() => {
                softHaptic();
                void startInstall(expectedFingerprint);
              }}
              disabled={busy}
            />
            <SecondaryButton label="Voltar" onPress={resetToForm} />
          </View>
        ) : null}

        {(stage === "inspect" || stage === "installing") && busy ? (
          <View style={styles.card}>
            <ActivityIndicator color={COLORS.blue} />
            <Text style={styles.hint}>
              {stage === "inspect"
                ? "Conectando sem credenciais para ler a impressão digital do host..."
                : operation === "update"
                  ? "Criando backup e atualizando o servidor. Não feche o app."
                  : "Instalando o servidor Quibt. Isso pode levar alguns minutos."}
            </Text>
          </View>
        ) : null}

        {events.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.label}>Progresso</Text>
            {events.map((event, index) => (
              <Text key={`${event.step}-${index}`} style={styles.eventLine}>
                [{event.step}] {event.status}: {event.message}
              </Text>
            ))}
          </View>
        ) : null}

        {stage === "done" ? (
          <View style={styles.card}>
            <Text style={styles.success}>
              {operation === "update" ? "Servidor atualizado." : "Quibt instalado."}
            </Text>
            {operation === "update" ? (
              <>
                <Text style={styles.hint}>
                  {previousRelease && updatedRelease
                    ? `${previousRelease} → ${updatedRelease}. A API voltou pronta e o backup foi preservado.`
                    : "A API voltou pronta e o backup foi preservado."}
                </Text>
                {backupPath ? (
                  <Text selectable style={styles.mono}>
                    Backup: {backupPath}
                  </Text>
                ) : null}
                <PrimaryButton label="Voltar à conta" onPress={() => router.back()} />
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  {resultUrl && resultCode
                    ? `Ele responde em ${resultUrl}. Falta só criar a sua conta de dona da instalação — o app já leva o código.`
                    : "Agora conecte este celular à instalação nova."}
                </Text>
                {resultUrl && resultCode ? (
                  <PrimaryButton
                    label={claiming ? "Ligando…" : "Criar minha conta"}
                    onPress={() => void claimAndSignUp()}
                  />
                ) : (
                  <PrimaryButton label="Conectar no celular" onPress={() => router.push("/scan")} />
                )}
                {claimError ? <Text style={styles.error}>{claimError}</Text> : null}
                {resultUrl ? (
                  <Text style={styles.hint} selectable>
                    URL: {resultUrl}
                    {resultCode ? ` · Código: ${resultCode}` : ""}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        ) : null}

        {stage === "error" && error ? (
          <View style={styles.card}>
            <Text style={styles.error}>{error}</Text>
            <PrimaryButton label="Tentar de novo" onPress={resetToForm} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: AUTH_BG },
  content: {
    paddingHorizontal: METRICS.pageInset + 2,
    paddingBottom: 36,
    gap: 14,
  },
  stage: {
    color: COLORS.primary,
    fontSize: 28,
    lineHeight: 33,
    fontWeight: "600",
    letterSpacing: -0.8,
    marginBottom: 2,
  },
  card: {
    padding: 16,
    borderRadius: RADII.lg,
    backgroundColor: COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    gap: 10,
  },
  label: {
    color: COLORS.tertiary,
    fontSize: TEXT_SIZES.xs,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginTop: 4,
  },
  hint: { color: COLORS.secondary, fontSize: TEXT_SIZES.md, lineHeight: 20 },
  mono: {
    color: COLORS.primary,
    fontSize: TEXT_SIZES.sm,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  monoInput: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: TEXT_SIZES.sm,
  },
  multiline: { minHeight: 120, textAlignVertical: "top" },
  modeRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: RADII.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.background,
  },
  modeChipActive: { borderColor: COLORS.blue, backgroundColor: COLORS.card },
  modeChipText: { color: COLORS.primary, fontSize: TEXT_SIZES.md, fontWeight: "600" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  toggleLabel: { color: COLORS.secondary, fontSize: TEXT_SIZES.md, flex: 1, paddingRight: 12 },
  eventLine: { color: COLORS.secondary, fontSize: TEXT_SIZES.sm, lineHeight: 18 },
  success: { color: COLORS.green, fontSize: TEXT_SIZES.lg, fontWeight: "600" },
  error: { color: COLORS.red, fontSize: TEXT_SIZES.md, lineHeight: 21 },
});
