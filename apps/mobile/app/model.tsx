import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS, ScreenHeader, useHeaderContentInset } from "../lib/design-system";
import { ModelSourceSection } from "../lib/model-source";

/** Qual modelo os bots usam, e com que credencial — uma tela só para isso. */
export default function ModelScreen() {
  const router = useRouter();
  const topInset = useHeaderContentInset();
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="auto" />
      <SafeAreaView style={styles.screen} edges={["bottom"]}>
        <ScreenHeader onBack={() => router.back()} />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: topInset }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Modelo</Text>
          <Text style={styles.subtitle}>
            Você paga o modelo direto a quem o faz. Troque quando quiser.
          </Text>
          <View style={{ marginTop: 18 }}>
            <ModelSourceSection />
          </View>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  title: {
    color: COLORS.primary,
    fontSize: 28,
    lineHeight: 33,
    fontWeight: "600",
    letterSpacing: -0.8,
  },
  subtitle: { color: COLORS.secondary, fontSize: 15, lineHeight: 21, marginTop: 6 },
});
