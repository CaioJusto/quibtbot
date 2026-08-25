import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
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
import { currentApiBase, displayApiHost, loadSessionToken, signUp } from "../lib/api";
import {
  AUTH_BG,
  AUTH_BUTTON,
  AUTH_BUTTON_TEXT,
  AUTH_FIELD,
  AUTH_FIELD_TEXT,
  AUTH_FRAME,
  AUTH_PLACEHOLDER,
  AuthMessage,
} from "../lib/auth-ui";
import { hasEnrollmentToken } from "../lib/bootstrap-pairing";
import { COLORS, ScreenHeader } from "../lib/design-system";

/**
 * A primeira conta de uma instalação: só o nome. O código que o instalador mostrou já
 * provou que a máquina é de quem está aqui; não há e-mail nem senha para inventar.
 * Quem chega depois da primeira conta entra pelo código (enter-code), nunca por aqui.
 */
export default function SignUp() {
  const router = useRouter();
  const { plan } = useLocalSearchParams<{ plan?: string }>();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [firstOwner, setFirstOwner] = useState(false);

  useEffect(() => {
    void Promise.all([loadSessionToken(), hasEnrollmentToken()]).then(([token, enrollment]) => {
      setHasSession(Boolean(token));
      setFirstOwner(enrollment);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: AUTH_BG, justifyContent: "center" }}>
        <ActivityIndicator color={COLORS.tertiary} />
      </View>
    );
  }
  if (hasSession) return <Redirect href="/onboarding" />;

  async function submit() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      // Primeira conta desta instalação: o código já provou o controle da máquina,
      // então e-mail e senha ficam com o servidor e ninguém precisa lembrar deles.
      await signUp({ name: name.trim() });
      router.replace(plan ? `/onboarding?plan=${encodeURIComponent(plan)}` : "/onboarding");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar a conta");
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
      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <ScreenHeader onBack={() => router.back()} />
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={AUTH_FRAME}>
            {firstOwner ? (
              <>
                <Text style={styles.title}>Como você se chama?</Text>
                <Text style={styles.lede}>
                  Só isso. Sem e-mail, sem senha — a conta fica em{" "}
                  {displayApiHost(currentApiBase())}.
                </Text>
                <TextInput
                  autoComplete="name"
                  textContentType="name"
                  autoCapitalize="words"
                  autoFocus
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                  placeholder="Seu nome"
                  placeholderTextColor={AUTH_PLACEHOLDER}
                  value={name}
                  onChangeText={setName}
                  accessibilityLabel="Seu nome"
                  style={[AUTH_FIELD, AUTH_FIELD_TEXT, styles.field]}
                />
                {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void submit()}
                  disabled={pending || !name.trim()}
                  style={[AUTH_BUTTON, { opacity: pending || !name.trim() ? 0.45 : 1 }]}
                >
                  {pending ? (
                    <ActivityIndicator color={COLORS.background} />
                  ) : (
                    <Text style={AUTH_BUTTON_TEXT}>Começar</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.title}>Entrar neste aparelho</Text>
                <Text style={styles.lede}>
                  Este Quibt já tem dono. Num aparelho que já entrou, abra Conta → Celular e pegue o
                  código.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.replace("/enter-code")}
                  style={AUTH_BUTTON}
                >
                  <Text style={AUTH_BUTTON_TEXT}>Tenho o código</Text>
                </Pressable>
              </>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = {
  title: {
    color: COLORS.primary,
    fontSize: 30,
    lineHeight: 35,
    fontWeight: "600" as const,
    letterSpacing: -0.9,
    textAlign: "center" as const,
  },
  lede: {
    color: COLORS.secondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center" as const,
    marginTop: 10,
  },
  field: { marginTop: 26, textAlign: "center" as const, fontSize: 18 },
};
