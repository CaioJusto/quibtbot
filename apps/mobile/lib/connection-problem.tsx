import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { currentApiBase } from "./api";
import { COLORS, PrimaryButton, SecondaryButton, SectionCard, textStyles } from "./design-system";

/**
 * Sem servidor a inbox mostrava um texto vermelho solto ("Network request failed").
 * Este cartão diz o que aconteceu em português, qual servidor o app procurou e o que
 * fazer: tentar de novo ou apontar para outro Quibt lendo o QR de novo. A regra de
 * reconhecer uma falha de rede mora em `live-link.ts`, pura, para a conversa usar também.
 */
export { isConnectionProblem } from "./live-link";

export function serverLabel(base: string = currentApiBase()): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export function ConnectionProblem({
  onRetry,
  retrying = false,
  compact = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const host = serverLabel();
  if (compact) {
    return (
      <View
        accessibilityRole="alert"
        style={{
          marginHorizontal: 18,
          marginTop: 8,
          borderRadius: 14,
          backgroundColor: COLORS.card,
          paddingHorizontal: 14,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={[textStyles.body, { color: COLORS.primary }]}>
            Sem contato com o seu Quibt
          </Text>
          <Text style={[textStyles.secondary, { color: COLORS.secondary }]}>
            {host} · mostrando o que já estava carregado
          </Text>
        </View>
        <Text
          onPress={onRetry}
          style={[textStyles.body, { color: COLORS.blue, fontWeight: "600" }]}
        >
          {retrying ? "Tentando…" : "Tentar de novo"}
        </Text>
      </View>
    );
  }
  return (
    <SectionCard style={{ marginHorizontal: 18, marginTop: 24, padding: 18, gap: 8 }}>
      <Text style={[textStyles.title, { color: COLORS.primary }]}>
        Não consegui falar com o seu Quibt
      </Text>
      <Text style={[textStyles.body, { color: COLORS.secondary }]}>
        O app procurou em {host} e não teve resposta. Confira se o computador que roda o Quibt está
        ligado e na mesma rede, ou aponte para outro lendo o QR de novo.
      </Text>
      <View style={{ marginTop: 10, gap: 10 }}>
        <PrimaryButton label={retrying ? "Tentando…" : "Tentar de novo"} onPress={onRetry} />
        <SecondaryButton label="Ler outro QR code" onPress={() => router.push("/scan")} />
      </View>
    </SectionCard>
  );
}
