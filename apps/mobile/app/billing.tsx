import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AgentMark } from "../lib/agent-mark";
import { type BillingSnapshot, rpc } from "../lib/api";
import { AUTH_BG } from "../lib/auth-ui";
import { COLORS } from "../lib/design-system";
import { AppSymbol } from "../lib/native";
import { billingReturnUrl } from "../lib/origin";
import {
  displayPlanName,
  displayPlanStatus,
  formatMeter,
  formatPlanPrice,
  formatTokenBudget,
  planHighlights,
} from "../lib/plans";

export default function Billing() {
  const router = useRouter();
  const { checkoutNotice: checkoutNoticeParam } = useLocalSearchParams<{
    checkoutNotice?: string;
  }>();
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(checkoutNoticeParam ?? null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await rpc<BillingSnapshot>("billing/get");
      setBilling(snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar a assinatura");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  async function subscribe(planId: string) {
    setBusy(planId);
    setError(null);
    setCheckoutNotice(null);
    try {
      const { url } = await rpc<{ url: string }>("billing/checkout", {
        planId,
        successUrl: billingReturnUrl("success"),
        cancelUrl: billingReturnUrl("canceled"),
      });
      await Linking.openURL(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "O checkout do Stripe não está configurado neste deploy.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function portal() {
    setBusy("portal");
    setError(null);
    try {
      const { url } = await rpc<{ url: string }>("billing/portal");
      await Linking.openURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível abrir o portal de cobrança");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: AUTH_BG }} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        <Pressable
          accessibilityLabel="Fechar assinatura"
          onPress={() => router.back()}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: COLORS.card,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppSymbol name="xmark" size={16} color={COLORS.primary} />
        </Pressable>
        <View
          style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}
        >
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ color: COLORS.primary, fontSize: 32, fontWeight: "600", marginTop: 24 }}>
              Assinatura
            </Text>
            <Text style={{ color: COLORS.secondary, fontSize: 16, marginTop: 8 }}>
              Comece no beta gratuito. Starter e Pro passam pelo Stripe.
            </Text>
          </View>
          <View style={{ flexDirection: "row" }}>
            <AgentMark color="#111316" shape="grok" size={36} />
            <View style={{ marginLeft: -10 }}>
              <AgentMark color="#E6855C" shape="freddy" size={36} />
            </View>
          </View>
        </View>
        {billing ? (
          <View style={{ marginTop: 24 }}>
            <Text style={{ color: COLORS.secondary, fontSize: 15 }}>
              Plano atual:{" "}
              <Text style={{ color: COLORS.primary }}>
                {billing.planId === "trial" ? "Beta gratuito" : displayPlanName(billing)} ·{` `}
                {displayPlanStatus(billing.status)}
              </Text>
              {billing.enabled ? "" : " · Stripe ainda não está ligado neste servidor"}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
              <Meter label="Bots" value={formatMeter(billing.usage.bots, billing.limits.maxBots)} />
              <Meter
                label="Tokens"
                value={formatMeter(
                  billing.usage.tokens,
                  billing.limits.tokensPerMonth,
                  formatTokenBudget,
                )}
              />
              <Meter
                label="Computador"
                value={formatMeter(
                  Math.round(billing.usage.computerMinutes / 60),
                  billing.limits.computerMinutesPerMonth === null
                    ? null
                    : billing.limits.computerMinutesPerMonth / 60,
                  (n) => `${n}h`,
                )}
              />
            </View>
          </View>
        ) : (
          <ActivityIndicator color={COLORS.secondary} style={{ marginTop: 24 }} />
        )}
        <View style={{ marginTop: 24, gap: 12 }}>
          {billing
            ? billing.plans.map((plan) => {
                const current = billing.planId === plan.id;
                const paid = plan.priceUsd > 0;
                return (
                  <View
                    key={plan.id}
                    style={{
                      borderRadius: 18,
                      borderWidth: 1,
                      borderColor: current ? COLORS.blue : COLORS.separator,
                      backgroundColor: COLORS.card,
                      padding: 18,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: COLORS.primary, fontSize: 20, fontWeight: "600" }}>
                        {plan.id === "trial" ? "Beta gratuito" : plan.name}
                      </Text>
                      {current ? (
                        <Text style={{ color: COLORS.blue, fontSize: 12 }}>Atual</Text>
                      ) : null}
                    </View>
                    <Text
                      style={{
                        color: COLORS.primary,
                        fontSize: 28,
                        fontWeight: "600",
                        marginTop: 8,
                      }}
                    >
                      {formatPlanPrice(plan.priceUsd)}
                      {paid ? (
                        <Text style={{ color: COLORS.secondary, fontSize: 15 }}> / mês</Text>
                      ) : null}
                    </Text>
                    {planHighlights(plan).map((line) => (
                      <Text
                        key={line}
                        style={{ color: COLORS.secondary, fontSize: 14, marginTop: 6 }}
                      >
                        {line}
                      </Text>
                    ))}
                    {paid ? (
                      <Pressable
                        onPress={() => void subscribe(plan.id)}
                        disabled={!billing?.enabled || current || busy !== null}
                        style={{
                          marginTop: 16,
                          backgroundColor: COLORS.primaryStrong,
                          borderRadius: 999,
                          paddingVertical: 12,
                          alignItems: "center",
                          opacity: !billing?.enabled || current || busy !== null ? 0.4 : 1,
                        }}
                      >
                        <Text style={{ color: COLORS.background, fontSize: 15, fontWeight: "600" }}>
                          {busy === plan.id
                            ? "Abrindo o Stripe…"
                            : current
                              ? "Plano atual"
                              : `Assinar ${plan.name}`}
                        </Text>
                      </Pressable>
                    ) : (
                      <Text style={{ color: COLORS.secondary, fontSize: 13, marginTop: 16 }}>
                        Incluso ao criar a conta.
                      </Text>
                    )}
                  </View>
                );
              })
            : null}
        </View>
        {checkoutNotice ? (
          <Text style={{ color: COLORS.orange, marginTop: 16 }}>{checkoutNotice}</Text>
        ) : null}
        {error ? <Text style={{ color: COLORS.red, marginTop: 16 }}>{error}</Text> : null}
        {billing?.enabled ? (
          <Pressable
            onPress={() => void portal()}
            disabled={busy !== null}
            style={{ marginTop: 20 }}
          >
            <Text style={{ color: COLORS.secondary, fontSize: 15 }}>
              Gerenciar cobrança no Stripe
            </Text>
          </Pressable>
        ) : (
          <Text style={{ color: COLORS.secondary, fontSize: 14, marginTop: 20 }}>
            O checkout pago ainda não está ligado neste servidor.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: COLORS.card, borderRadius: 12, padding: 12 }}>
      <Text style={{ color: COLORS.secondary, fontSize: 12, textTransform: "uppercase" }}>
        {label}
      </Text>
      <Text style={{ color: COLORS.primary, fontSize: 17, fontWeight: "600", marginTop: 4 }}>
        {value}
      </Text>
    </View>
  );
}
