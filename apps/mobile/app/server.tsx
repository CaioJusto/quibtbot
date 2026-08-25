import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
} from "../lib/api";
import { AUTH_BG, AUTH_FIELD, AUTH_FIELD_TEXT, AUTH_PLACEHOLDER } from "../lib/auth-ui";
import { COLORS } from "../lib/design-system";

/**
 * O caminho manual para a mesma coisa que o QR resolve: dizer com qual servidor este app
 * fala. Serve para uma VPS na internet, ou quando não dá para ler o QR.
 */
export default function Server() {
  const router = useRouter();
  const current = currentApiBase();
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  async function save() {
    setPending(true);
    setError(null);
    try {
      const probed = await probeApiBase(draft);
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      router.back();
    } finally {
      setPending(false);
    }
  }

  async function restoreDefault() {
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      router.back();
    } finally {
      setPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: AUTH_BG }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="auto" />
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 24, paddingTop: 12 }}>
        <View style={styles.bar}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.cancel}>Cancelar</Text>
          </Pressable>
          <Text style={styles.barTitle}>Servidor</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void save()}
            disabled={pending}
            hitSlop={8}
          >
            <Text style={styles.save}>{pending ? "Verificando…" : "Salvar"}</Text>
          </Pressable>
        </View>
        <Text style={styles.body}>
          Aponte este app para a API do Quibt Bot — a mesma origem do app no navegador. Se o
          computador está na sua rede, ler o QR dele é mais rápido.
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          autoFocus
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onSubmitEditing={() => void save()}
          placeholder={defaultApiBase()}
          placeholderTextColor={AUTH_PLACEHOLDER}
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          style={[AUTH_FIELD, AUTH_FIELD_TEXT, { marginTop: 20 }]}
        />
        {warning ? <Text style={styles.warning}>{warning}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {current !== defaultApiBase() || draft.trim() !== current ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void restoreDefault()}
            disabled={pending}
            style={{ marginTop: 26, alignItems: "center" }}
          >
            <Text style={styles.reset}>Usar o servidor padrão</Text>
          </Pressable>
        ) : null}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cancel: { color: COLORS.secondary, fontSize: 17 },
  barTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  save: { color: COLORS.blue, fontSize: 17, fontWeight: "600" },
  body: { color: COLORS.secondary, marginTop: 26, fontSize: 15, lineHeight: 21 },
  warning: { color: COLORS.secondary, marginTop: 12, fontSize: 13 },
  error: { color: COLORS.red, marginTop: 12 },
  reset: { color: COLORS.secondary, fontSize: 15 },
});
