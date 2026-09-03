import {
  formatQuibtCloudHours,
  isQuibtCloudPlaceholderUrl,
  quibtCloudUsage,
  resolveQuibtCloudApiUrl,
  type QuibtCloudBox,
  type QuibtCloudLimit,
  type QuibtCloudMe,
} from "@quibt/core";
import {
  createQuibtCloudClient,
  isQuibtCloudLimitError,
  QuibtCloudSession,
} from "@quibt/adapters/quibt-cloud-client";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BRAND_BLUE } from "../lib/brand";
import { COLORS } from "../lib/design-system";

const SESSION_KEY = "quibt.cloud.session.v1";

type QuibtCloudSessionPersist = {
  token: string;
  email: string;
  apiUrl: string;
  savedAt: string;
};

async function loadSession(): Promise<QuibtCloudSessionPersist | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuibtCloudSessionPersist;
    if (!parsed.token?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(session: QuibtCloudSessionPersist): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export function QuibtCloudPanel({
  configured,
  disabled,
  onSessionToken,
}: {
  configured?: boolean;
  disabled?: boolean;
  onSessionToken: (token: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<QuibtCloudMe | null>(null);
  const [boxes, setBoxes] = useState<QuibtCloudBox[]>([]);
  const [limitNotice, setLimitNotice] = useState<QuibtCloudLimit | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiUrl = useMemo(() => resolveQuibtCloudApiUrl({}), []);
  const usage = useMemo(() => (me ? quibtCloudUsage(me) : null), [me]);
  const placeholderApi = isQuibtCloudPlaceholderUrl(apiUrl);

  useEffect(() => {
    void loadSession().then((saved) => {
      if (!saved) return;
      setEmail(saved.email);
      setToken(saved.token);
    });
  }, []);

  useEffect(() => {
    if (!token && configured) return;
    onSessionToken(token);
  }, [configured, onSessionToken, token]);

  useEffect(() => {
    if (!token) return;
    void refresh(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function session(activeToken: string) {
    return new QuibtCloudSession(createQuibtCloudClient({ baseUrl: apiUrl, token: activeToken }));
  }

  async function login() {
    setPending(true);
    setError(null);
    setLimitNotice(null);
    try {
      const client = createQuibtCloudClient({ baseUrl: apiUrl });
      const cloud = new QuibtCloudSession(client);
      await cloud.login(email.trim(), password);
      const snap = await cloud.refresh();
      const nextToken = snap.token;
      if (!nextToken) throw new Error("A Cloud não devolveu token de sessão.");
      await saveSession({
        token: nextToken,
        email: email.trim(),
        apiUrl,
        savedAt: new Date().toISOString(),
      });
      setToken(nextToken);
      setPassword("");
      setMe(snap.me);
      setBoxes(snap.boxes);
      onSessionToken(nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar na conta Cloud");
    } finally {
      setPending(false);
    }
  }

  async function refresh(activeToken = token) {
    if (!activeToken) return;
    setPending(true);
    setError(null);
    try {
      const snap = await session(activeToken).refresh();
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível atualizar a conta Cloud");
    } finally {
      setPending(false);
    }
  }

  async function resumeBox(boxId: string) {
    if (!token) return;
    setPending(true);
    setError(null);
    setLimitNotice(null);
    try {
      const snap = await session(token).resume(boxId);
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
    } catch (err) {
      if (isQuibtCloudLimitError(err)) {
        setLimitNotice(err.limit);
        setError(err.limit.upgradeMessage);
        return;
      }
      setError(err instanceof Error ? err.message : "Não foi possível ligar a box");
    } finally {
      setPending(false);
    }
  }

  async function stopBox(boxId: string) {
    if (!token) return;
    setPending(true);
    setError(null);
    try {
      const snap = await session(token).stop(boxId);
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível desligar a box");
    } finally {
      setPending(false);
    }
  }

  async function logout() {
    await clearSession();
    setToken(null);
    setPassword("");
    setMe(null);
    setBoxes([]);
    setLimitNotice(null);
    onSessionToken(null);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.hint}>
        Opcional. Entre na conta Quibt Bot Cloud para ligar a VM do plano. Os modos locais seguem sem
        essa conta.
      </Text>
      {placeholderApi ? (
        <Text style={styles.placeholder}>
          API Cloud placeholder ({apiUrl}). Defina QUIBT_CLOUD_API_URL quando o backend estiver pronto.
        </Text>
      ) : null}
      {!token ? (
        <>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="E-mail da conta Cloud"
            placeholderTextColor={COLORS.tertiary}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
            editable={!disabled && !pending}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Senha"
            placeholderTextColor={COLORS.tertiary}
            secureTextEntry
            style={styles.input}
            editable={!disabled && !pending}
          />
          <Pressable
            disabled={disabled || pending || !email.trim() || !password}
            onPress={() => void login()}
            style={[styles.primaryButton, (disabled || pending) && styles.disabled]}
          >
            {pending ? (
              <ActivityIndicator color={COLORS.background} />
            ) : (
              <Text style={styles.primaryText}>Entrar na conta Cloud</Text>
            )}
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.planTitle}>{me?.plan.name ?? "Plano Cloud"}</Text>
              <Text style={styles.planMeta}>{me ? formatQuibtCloudHours(me) : "Carregando…"}</Text>
              {usage ? (
                <Text style={styles.planMeta}>
                  {usage.concurrentComputers}/{usage.concurrentLimit} computador(es) ligados
                </Text>
              ) : null}
            </View>
            <Pressable disabled={disabled || pending} onPress={() => void refresh()}>
              <Text style={styles.link}>Atualizar</Text>
            </Pressable>
            <Pressable disabled={disabled || pending} onPress={() => void logout()}>
              <Text style={styles.link}>Sair</Text>
            </Pressable>
          </View>
          {boxes.map((box) => (
            <View key={box.id} style={styles.boxRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.boxId}>{box.id}</Text>
                <Text style={styles.boxStatus}>{box.status === "running" ? "Ligada" : "Desligada"}</Text>
              </View>
              {box.status === "running" ? (
                <Pressable
                  disabled={disabled || pending}
                  onPress={() => void stopBox(box.id)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryText}>Desligar</Text>
                </Pressable>
              ) : (
                <Pressable
                  disabled={disabled || pending}
                  onPress={() => void resumeBox(box.id)}
                  style={styles.primaryButtonSmall}
                >
                  <Text style={styles.primaryText}>Ligar</Text>
                </Pressable>
              )}
            </View>
          ))}
        </>
      )}
      {limitNotice ? <Text style={styles.limit}>{limitNotice.upgradeMessage}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12, gap: 10 },
  hint: { color: COLORS.secondary, fontSize: 13, lineHeight: 18 },
  placeholder: {
    color: COLORS.tertiary,
    fontSize: 12,
    lineHeight: 17,
    padding: 10,
    borderRadius: 12,
    backgroundColor: COLORS.card,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.separator,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  planTitle: { color: COLORS.primary, fontSize: 15, fontWeight: "700" },
  planMeta: { color: COLORS.secondary, fontSize: 12, marginTop: 2 },
  link: { color: BRAND_BLUE, fontSize: 13, fontWeight: "600" },
  boxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
  },
  boxId: { color: COLORS.primary, fontSize: 14, fontWeight: "600" },
  boxStatus: { color: COLORS.secondary, fontSize: 12 },
  primaryButton: {
    backgroundColor: BRAND_BLUE,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryButtonSmall: {
    backgroundColor: BRAND_BLUE,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  primaryText: { color: COLORS.background, fontWeight: "700", fontSize: 14 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: COLORS.separator,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secondaryText: { color: COLORS.primary, fontSize: 13, fontWeight: "600" },
  limit: { color: COLORS.secondary, fontSize: 12, lineHeight: 17 },
  error: { color: COLORS.primary, fontSize: 13 },
  disabled: { opacity: 0.5 },
});
