import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { currentApiBase, displayApiHost, normalizeApiBase } from "../lib/api";
import { AUTH_BG, AUTH_FIELD, AUTH_FIELD_TEXT, AUTH_PLACEHOLDER } from "../lib/auth-ui";
import { claimInstallation, confirmBootstrapLink } from "../lib/bootstrap-pairing";
import {
  COLORS,
  METRICS,
  PrimaryButton,
  ScreenHeader,
  TEXT_SIZES,
  useHeaderContentInset,
} from "../lib/design-system";

/**
 * Depois que o instalador termina, o celular valida o código de oito caracteres e guarda
 * o convite de proprietário separado da sessão. Só então o cadastro inicial fica disponível.
 */
export default function PairInstallation() {
  const router = useRouter();
  const topInset = useHeaderContentInset();
  const {
    api: linkedApi,
    token,
    error: initialError,
  } = useLocalSearchParams<{
    api?: string;
    token?: string;
    error?: string;
  }>();
  const isLinkConfirmation = Boolean(linkedApi?.trim() && token?.trim());
  const [apiDraft, setApiDraft] = useState(linkedApi?.trim() || currentApiBase());
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError?.trim() || null);
  const [pending, setPending] = useState(false);

  const parsedApi = normalizeApiBase(apiDraft);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = isLinkConfirmation
        ? await confirmBootstrapLink(
            `quibt://bootstrap?api=${encodeURIComponent(apiDraft)}&token=${encodeURIComponent(token!.trim())}`,
          )
        : await claimInstallation(apiDraft, code);
      if (!result.ok) {
        // `error` vazio vinha de um deep link mal formado: o botão "funcionava" e nada
        // aparecia. Quem toca precisa de uma frase, sempre.
        setError(result.error || "Não foi possível validar este convite. Leia o QR de novo.");
        return;
      }
      router.replace("/sign-up");
    } catch (err) {
      // Sem isto, uma falha ao gravar no chaveiro (SecureStore) morria em silêncio:
      // o convite já tinha sido consumido no servidor e a tela ficava parada.
      setError(
        err instanceof Error && err.message
          ? `Não consegui guardar a conexão neste aparelho: ${err.message}`
          : "Não consegui guardar a conexão neste aparelho.",
      );
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
      <SafeAreaView style={styles.screen} edges={["bottom"]}>
        <ScreenHeader onBack={() => router.back()} title="Validar instalação" />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: topInset }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>
            {isLinkConfirmation ? "Confirmar servidor" : "Código do instalador"}
          </Text>
          <Text style={styles.body}>
            {isLinkConfirmation
              ? `Este QR quer conectar o Quibt a ${parsedApi.ok ? displayApiHost(parsedApi.url) : "outro servidor"}. Confirme apenas se esse é o endereço da sua instalação.`
              : "Cole a URL que o instalador mostrou e o código de oito letras. Isso prova que você controla o servidor antes de criar a conta de proprietário."}
          </Text>

          <Text style={styles.label}>URL do servidor</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://quibt.seudominio.com"
            placeholderTextColor={AUTH_PLACEHOLDER}
            value={apiDraft}
            onChangeText={setApiDraft}
            editable={!isLinkConfirmation}
            style={[AUTH_FIELD, AUTH_FIELD_TEXT]}
          />
          {parsedApi.ok ? (
            <Text style={styles.hint}>Servidor: {displayApiHost(parsedApi.url)}</Text>
          ) : (
            <Text style={styles.errorHint}>{parsedApi.error}</Text>
          )}

          {!isLinkConfirmation ? (
            <>
              <Text style={styles.label}>Código</Text>
              <TextInput
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={12}
                placeholder="ABCD1234"
                placeholderTextColor={AUTH_PLACEHOLDER}
                value={code}
                onChangeText={setCode}
                style={[AUTH_FIELD, AUTH_FIELD_TEXT, styles.codeField]}
              />
            </>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PrimaryButton
            label={
              pending
                ? "Validando…"
                : isLinkConfirmation
                  ? "Confiar neste servidor"
                  : "Continuar para o cadastro"
            }
            onPress={() => void submit()}
            disabled={pending || !parsedApi.ok || (!isLinkConfirmation && !code.trim())}
            style={styles.submit}
          />

          <Pressable accessibilityRole="button" onPress={() => router.push("/scan")}>
            <Text style={styles.link}>Ler o QR em vez disso</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: METRICS.pageInset + 2,
    paddingBottom: 36,
  },
  title: {
    color: COLORS.primary,
    fontSize: TEXT_SIZES.title,
    lineHeight: 29,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  body: {
    color: COLORS.secondary,
    fontSize: TEXT_SIZES.md,
    lineHeight: 21,
    marginTop: 10,
  },
  label: {
    color: COLORS.tertiary,
    fontSize: TEXT_SIZES.xs,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginTop: 22,
    marginBottom: 8,
  },
  hint: { color: COLORS.tertiary, fontSize: TEXT_SIZES.sm, marginTop: 6 },
  errorHint: { color: COLORS.red, fontSize: TEXT_SIZES.sm, marginTop: 6 },
  codeField: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    letterSpacing: 1.2,
  },
  error: {
    color: COLORS.red,
    fontSize: TEXT_SIZES.md,
    lineHeight: 20,
    marginTop: 14,
  },
  submit: { marginTop: 24 },
  link: {
    color: COLORS.blue,
    fontSize: TEXT_SIZES.md,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 22,
  },
});
