import { formatDeviceCode, isWellFormedDeviceCode } from "@quibt/core/device-code";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { currentApiBase, displayApiHost, pollPairRequest, requestSignInWithCode } from "../lib/api";
import {
  AUTH_BG,
  AUTH_BUTTON,
  AUTH_BUTTON_TEXT,
  AUTH_FIELD,
  AUTH_FIELD_TEXT,
  AUTH_FRAME,
  AUTH_PANEL,
  AUTH_PLACEHOLDER,
  AuthMessage,
} from "../lib/auth-ui";
import { COLORS, ScreenHeader } from "../lib/design-system";

/**
 * Entrar sem e-mail e sem senha.
 *
 * A conta do Quibt vive no computador ou na VPS de quem instalou — não há nuvem
 * onde recuperá-la, e esta instalação nem envia e-mail. Então o que vale como
 * prova é ter acesso a um aparelho que já entrou: ele mostra um código de oito
 * caracteres (Conta → Celular, no computador) e este aqui digita.
 */
/** Quanto tempo a tela espera pelo sim antes de desistir, e de quanto em quanto pergunta. */
const WAIT_LIMIT_MS = 120_000;
const POLL_MS = 2_000;

/**
 * O nome que aparece para quem vai aprovar. Sai do que o próprio Expo já sabe do
 * aparelho — instalar uma biblioteca só para isso custaria um build nativo novo, e o
 * que importa aqui é a pessoa reconhecer o telefone na mão, não identificá-lo.
 */
function deviceName(): string {
  const model = Constants.deviceName?.trim();
  if (model) return model;
  return Platform.OS === "ios" ? "iPhone" : "Celular";
}

export default function EnterCode() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const ready = isWellFormedDeviceCode(code);

  /**
   * Acertar o código põe este aparelho numa fila; entrar mesmo depende de quem está no
   * computador dizer sim. Enquanto isso a tela espera e diz o que está esperando, em
   * vez de fingir que travou.
   */
  async function submit() {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    setWaiting(false);
    try {
      const request = await requestSignInWithCode(code, deviceName());
      setWaiting(true);
      const deadline = Date.now() + WAIT_LIMIT_MS;
      while (Date.now() < deadline) {
        const outcome = await pollPairRequest(request);
        if (outcome.state === "approved") {
          router.replace("/");
          return;
        }
        if (outcome.state === "denied") {
          setError("O computador recusou este aparelho.");
          return;
        }
        if (outcome.state !== "pending") {
          setError("O pedido expirou. Gere um código novo no computador.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      setError("Ninguém aprovou a tempo. Tente de novo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar com esse código");
    } finally {
      setPending(false);
      setWaiting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: AUTH_BG }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="auto" />
      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <ScreenHeader onBack={() => router.back()} />
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingTop: 60 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={AUTH_FRAME}>
            <View style={AUTH_PANEL}>
              <Text
                style={{
                  color: COLORS.primary,
                  fontSize: 30,
                  lineHeight: 35,
                  fontWeight: "600",
                  letterSpacing: -0.9,
                  textAlign: "center",
                }}
              >
                Digite o código
              </Text>
              <Text
                style={{
                  color: COLORS.secondary,
                  fontSize: 15,
                  lineHeight: 21,
                  marginTop: 10,
                  textAlign: "center",
                }}
              >
                Ele aparece em Conta → Celular num aparelho que já entrou.
              </Text>
              <TextInput
                value={formatDeviceCode(code)}
                onChangeText={(text) => setCode(text.replace(/\s+/g, "").slice(0, 8))}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                placeholder="ABCD 1234"
                placeholderTextColor={AUTH_PLACEHOLDER}
                accessibilityLabel="Código de entrada"
                style={[
                  AUTH_FIELD,
                  AUTH_FIELD_TEXT,
                  { marginTop: 26, fontSize: 26, letterSpacing: 6, textAlign: "center" },
                ]}
              />
              {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => void submit()}
                disabled={!ready || pending}
                style={[AUTH_BUTTON, { opacity: !ready || pending ? 0.55 : 1 }]}
              >
                {pending ? (
                  <ActivityIndicator color={COLORS.background} />
                ) : (
                  <Text style={AUTH_BUTTON_TEXT}>Entrar</Text>
                )}
              </Pressable>
              <Text
                style={{
                  color: COLORS.tertiary,
                  fontSize: 12.5,
                  lineHeight: 17,
                  marginTop: 14,
                  textAlign: "center",
                }}
              >
                {waiting
                  ? `Código aceito. Aprove "${deviceName()}" no outro aparelho.`
                  : `Entrando em ${displayApiHost(currentApiBase())}.`}
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}
