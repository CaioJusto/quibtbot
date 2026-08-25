import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type BillingSnapshot,
  deleteAccount,
  rpc,
  SIGN_OUT_TIMEOUT_MS,
  signOut,
  updateProfile,
  withDeadline,
} from "../lib/api";
import {
  type AppearanceChoice,
  appearanceLabel,
  applyAppearance,
  loadAppearance,
  saveAppearance,
} from "../lib/appearance";
import { type AvatarSource, pickAvatar } from "../lib/avatar";
import { QuibtWordmark } from "../lib/brand";
import { COLORS, GlassIconButton, softHaptic } from "../lib/design-system";
import {
  forgetInfrastructureCredential,
  formatInfrastructureAuthType,
  type InfrastructureCredentialMetadata,
  listInfrastructureCredentialMetadata,
} from "../lib/infrastructure-secrets";
import { currentModelSummary } from "../lib/model-source";
import { AppSymbol, type AppSymbolName, showNativeSheet } from "../lib/native";
import { displayPlanName, formatMeter, formatTokenBudget } from "../lib/plans";
import { unregisterPushToken } from "../lib/push";

type Profile = { name?: string; email?: string; image?: string | null };

/**
 * A conta: a pessoa (foto e nome) e, embaixo, o que ela configura — modelo, máquina,
 * plugins, outro aparelho. Sem e-mail nem senha: a conta mora no Quibt da pessoa, e
 * entrar é pela máquina ou pelo código; não há nada disso para ela guardar.
 */
export default function Account() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [me, setMe] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [modelSummary, setModelSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<AppearanceChoice>("system");
  const [pending, setPending] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [infraCredentials, setInfraCredentials] = useState<InfrastructureCredentialMetadata[]>([]);

  useEffect(() => {
    void loadAppearance().then(setAppearance);
    void listInfrastructureCredentialMetadata()
      .then(setInfraCredentials)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void Promise.all([
      rpc<Profile>("me"),
      rpc<BillingSnapshot>("billing/get").catch(() => null),
      currentModelSummary().catch(() => null),
    ])
      .then(([profile, snap, summary]) => {
        setMe(profile);
        setName(profile.name ?? "");
        setBilling(snap);
        setModelSummary(summary);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Não foi possível carregar a conta"),
      );
  }, []);

  async function saveName() {
    const next = name.trim();
    if (!next || next === me?.name) return;
    setError(null);
    try {
      await updateProfile({ name: next });
      setMe((current) => ({ ...(current ?? {}), name: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar o nome");
    }
  }

  async function changePhoto(source: AvatarSource) {
    setPhotoBusy(true);
    setError(null);
    try {
      const image = await pickAvatar(source);
      if (!image) return;
      await updateProfile({ image });
      setMe((current) => ({ ...(current ?? {}), image }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar a foto");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    setError(null);
    try {
      await updateProfile({ image: null });
      setMe((current) => ({ ...(current ?? {}), image: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível remover a foto");
    } finally {
      setPhotoBusy(false);
    }
  }

  function choosePhoto() {
    softHaptic();
    showNativeSheet({
      title: "Foto de perfil",
      actions: [
        { label: "Escolher da galeria", onPress: () => void changePhoto("library") },
        { label: "Tirar foto", onPress: () => void changePhoto("camera") },
        ...(me?.image
          ? [{ label: "Remover foto", destructive: true, onPress: () => void removePhoto() }]
          : []),
      ],
    });
  }

  function confirmForgetCredential(row: InfrastructureCredentialMetadata) {
    showNativeSheet({
      title: "Esquecer credencial",
      message: `Remove ${row.label} deste aparelho. Você precisará informar de novo na próxima instalação remota.`,
      actions: [
        {
          label: "Esquecer",
          destructive: true,
          onPress: () => {
            void forgetInfrastructureCredential(row.hostId)
              .then(() =>
                setInfraCredentials((current) =>
                  current.filter((item) => item.hostId !== row.hostId),
                ),
              )
              .catch(() => undefined);
          },
        },
      ],
    });
  }

  function confirmSignOut() {
    showNativeSheet({
      title: "Sair da conta",
      message: "Você vai precisar entrar de novo neste aparelho.",
      actions: [
        {
          label: "Sair",
          destructive: true,
          onPress: () =>
            void withDeadline(unregisterPushToken(), SIGN_OUT_TIMEOUT_MS, undefined)
              .then(signOut)
              .catch(() => undefined)
              // Sair leva para a entrada mesmo se algo falhou no caminho.
              .finally(() => router.replace("/welcome")),
        },
      ],
    });
  }

  function confirmDelete() {
    showNativeSheet({
      title: "Apagar conta",
      message:
        "Apaga seus bots, computadores, memória e conexões deste workspace. Não dá para desfazer.",
      actions: [
        {
          label: "Apagar tudo",
          destructive: true,
          onPress: () => {
            setPending(true);
            setError(null);
            void deleteAccount()
              .then(() => router.replace("/welcome"))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Não foi possível apagar a conta");
                setPending(false);
              });
          },
        },
      ],
    });
  }

  const initial = (me?.name ?? "U").slice(0, 1).toUpperCase();

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: insets.top + 14,
          paddingBottom: insets.bottom + 40,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <GlassIconButton symbol="xmark" label="Fechar conta" onPress={() => router.back()} />

        <View style={styles.hero}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Trocar foto de perfil"
            onPress={choosePhoto}
            disabled={photoBusy}
            style={[styles.avatarWrap, photoBusy && { opacity: 0.6 }]}
          >
            {me?.image ? (
              <Image
                cachePolicy="memory-disk"
                contentFit="cover"
                source={{ uri: me.image }}
                style={styles.avatar}
                transition={120}
              />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarInitial}>{initial}</Text>
              </View>
            )}
            <View style={styles.cameraBadge}>
              <AppSymbol name="pencil" size={13} color={COLORS.background} />
            </View>
          </Pressable>
          <TextInput
            value={name}
            onChangeText={setName}
            onBlur={() => void saveName()}
            onSubmitEditing={() => void saveName()}
            returnKeyType="done"
            autoComplete="name"
            textContentType="name"
            placeholder="Seu nome"
            placeholderTextColor={COLORS.tertiary}
            accessibilityLabel="Seu nome"
            style={styles.nameField}
          />
          <Text style={styles.heroHint}>Toque na foto ou no nome para trocar.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        <Text style={styles.groupLabel}>Seu Quibt</Text>
        <View style={styles.group}>
          <Row
            icon="bolt.horizontal.circle"
            title="Modelo"
            detail={modelSummary ?? undefined}
            onPress={() => router.push("/model")}
          />
          <Row
            icon="desktopcomputer"
            title="Máquina dos bots"
            onPress={() => router.push("/machine-settings")}
          />
          <Row
            icon="puzzlepiece.extension.fill"
            title="Plugins"
            onPress={() => router.push("/plugins")}
          />
          <Row
            icon="circle.lefthalf.filled"
            title="Aparência"
            detail={appearanceLabel(appearance)}
            onPress={() => {
              const pick = (choice: AppearanceChoice) => {
                setAppearance(choice);
                applyAppearance(choice);
                void saveAppearance(choice);
              };
              showNativeSheet({
                title: "Aparência",
                actions: (["system", "light", "dark"] as const).map((choice) => ({
                  label: appearanceLabel(choice),
                  onPress: () => pick(choice),
                })),
              });
            }}
          />
          {billing?.enabled ? (
            <Row
              icon="crown"
              title="Planos e cobrança"
              detail={`${billing.planId === "trial" ? "Beta" : displayPlanName(billing)} · ${formatMeter(billing.usage.bots, billing.limits.maxBots)} bots · ${formatMeter(billing.usage.tokens, billing.limits.tokensPerMonth, formatTokenBudget)} tokens`}
              onPress={() => router.push("/billing")}
              last
            />
          ) : null}
        </View>

        {infraCredentials.length > 0 ? (
          <>
            <Text style={styles.groupLabel}>Credenciais de infraestrutura</Text>
            <View style={styles.group}>
              {infraCredentials.map((row, index) => (
                <Row
                  key={row.hostId}
                  icon="lock.fill"
                  title={row.label}
                  detail={`${formatInfrastructureAuthType(row.authType)} · usado em ${formatLastUsed(row.lastUsedAt)}`}
                  actionLabel="Esquecer"
                  onPress={() => confirmForgetCredential(row)}
                  last={index === infraCredentials.length - 1}
                />
              ))}
            </View>
            <Text style={styles.groupHint}>
              Senhas SSH, chaves privadas e chaves Box ficam só neste aparelho, protegidas por
              biometria.
            </Text>
          </>
        ) : null}

        <View style={[styles.group, { marginTop: 28 }]}>
          <Row title="Sair" danger onPress={confirmSignOut} />
          <Row title="Apagar conta" danger onPress={confirmDelete} disabled={pending} last />
        </View>

        <View style={styles.brandFooter}>
          <Text style={styles.brandFooterLabel}>feito por</Text>
          <QuibtWordmark width={96} />
        </View>
      </ScrollView>
    </View>
  );
}

function formatLastUsed(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

function Row({
  icon,
  title,
  detail,
  actionLabel,
  onPress,
  danger,
  disabled,
  last,
}: {
  icon?: AppSymbolName;
  title: string;
  detail?: string;
  actionLabel?: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        softHaptic();
        onPress();
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        !last && styles.rowDivider,
        pressed && styles.rowPressed,
        disabled && { opacity: 0.5 },
      ]}
    >
      {icon ? (
        <View style={styles.rowIcon}>
          <AppSymbol name={icon} size={17} color={COLORS.primary} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, danger && { color: COLORS.red }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {actionLabel ? (
        <Text style={styles.rowAction}>{actionLabel}</Text>
      ) : danger ? null : (
        <AppSymbol name="chevron.right" size={14} color={COLORS.tertiary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  hero: { alignItems: "center", marginTop: 18, marginBottom: 26 },
  avatarWrap: { position: "relative" },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarFallback: {
    backgroundColor: COLORS.card,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: COLORS.primary, fontSize: 36, fontWeight: "700" },
  cameraBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.primaryStrong,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: COLORS.background,
  },
  nameField: {
    marginTop: 14,
    color: COLORS.primary,
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: -0.5,
    textAlign: "center",
    minWidth: 180,
    paddingVertical: 4,
  },
  heroHint: { color: COLORS.tertiary, fontSize: 12.5, marginTop: 4 },
  error: { color: COLORS.red, fontSize: 13, marginTop: 10, textAlign: "center" },
  groupLabel: {
    color: COLORS.tertiary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 18,
    marginBottom: 8,
    marginLeft: 14,
  },
  group: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    overflow: "hidden",
  },
  groupHint: { color: COLORS.tertiary, fontSize: 12.5, marginTop: 8, marginHorizontal: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 50,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.separator },
  rowPressed: { backgroundColor: COLORS.cardRaised },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: COLORS.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: COLORS.primary, fontSize: 16 },
  rowDetail: { color: COLORS.secondary, fontSize: 13, marginTop: 2 },
  rowAction: { color: COLORS.red, fontSize: 15, fontWeight: "600" },
  brandFooter: { alignItems: "center", justifyContent: "center", marginTop: 40, opacity: 0.82 },
  brandFooterLabel: {
    color: COLORS.tertiary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
});
