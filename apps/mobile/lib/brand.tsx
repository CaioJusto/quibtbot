import { tokens } from "@quibt/ui-tokens";
import {
  Image,
  type ImageSourcePropType,
  type ImageStyle,
  type StyleProp,
  View,
} from "react-native";

/** O azul da marca. Para ação e foco use `COLORS.blue`, que é o token do produto. */
export const BRAND_BLUE = "#0071FB";
export const BRAND_BLUE_DARK = "#0057C8";
export const BRAND_BLUE_SOFT = "rgba(0,113,251,0.10)";

const WORDMARK = require("../assets/quibt-wordmark.png");
const MARK_BLUE = require("../assets/quibt-mark-blue.png");
const MARK_INVERSE = require("../assets/quibt-mark-inverse.png");
const APP_ICON = require("../assets/icon.png");

/**
 * As mesmas ilustrações do web (`apps/web/public/quibt-*.png`). Se uma delas mudar lá,
 * copie de novo — o time de personagens tem que ser o mesmo nas três telas do produto.
 */
const TEAM_ART = require("../assets/quibt-onboarding-team.webp");
const COMPUTER_ART = require("../assets/quibt-computer-setup.webp");
const PROFILE_ART = require("../assets/quibt-account-profile.webp");

/** Artes de marca que abrem com o app (entrada, cadastro, conta). */
export function brandSources(): ImageSourcePropType[] {
  return [WORDMARK, MARK_BLUE, MARK_INVERSE, APP_ICON, TEAM_ART, COMPUTER_ART, PROFILE_ART];
}

/** O ícone que a pessoa reconhece na tela inicial do iPhone. */
export function QuibtAppIcon({ size = 72 }: { size?: number }) {
  return (
    <Image
      accessibilityLabel="Ícone do Quibt Bot"
      source={APP_ICON}
      resizeMode="contain"
      style={{ width: size, height: size, borderRadius: size * 0.22 }}
    />
  );
}

export function QuibtWordmark({
  width = 148,
  style,
}: {
  width?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityLabel="Quibt"
      source={WORDMARK}
      resizeMode="contain"
      style={[{ width, height: width * (199 / 538) }, style]}
    />
  );
}

export function QuibtMark({
  size = 72,
  inverse = false,
  style,
}: {
  size?: number;
  inverse?: boolean;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityLabel="Símbolo Quibt"
      source={inverse ? MARK_INVERSE : MARK_BLUE}
      resizeMode="contain"
      style={[{ width: size, height: size }, style]}
    />
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center" }}>
      <QuibtMark size={compact ? 56 : 76} />
      <QuibtWordmark width={compact ? 96 : 126} style={{ marginTop: compact ? 4 : 8 }} />
    </View>
  );
}

/** O time de personagens, a mesma arte que abre o web. É ele que apresenta o produto. */
export function QuibtTeam({
  width = 300,
  style,
}: {
  width?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityLabel="Dora, Bento, Nilo e Lumi, os personagens do Quibt Bot"
      source={TEAM_ART}
      resizeMode="contain"
      style={[{ width, height: width * 0.6255 }, style]}
    />
  );
}

/** O personagem ao lado do computador dele — a tela que explica a máquina. */
export function QuibtComputerArt({
  width = 260,
  style,
}: {
  width?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityLabel="Personagem do Quibt ao lado de um computador"
      source={COMPUTER_ART}
      resizeMode="contain"
      style={[{ width, height: width * 0.8 }, style]}
    />
  );
}

/** O personagem com o cartão de perfil, usado no topo da conta. */
export function QuibtProfileArt({
  width = 190,
  style,
}: {
  width?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityLabel="Personagem do Quibt segurando um cartão de perfil"
      source={PROFILE_ART}
      resizeMode="contain"
      style={[{ width, height: width * 0.6667 }, style]}
    />
  );
}

/** Um halo suave da marca, para pousar uma arte sobre a página clara. */
export function BrandGlow({ size = 190 }: { size?: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: BRAND_BLUE_SOFT,
      }}
    />
  );
}

export const BRAND_INK = tokens.ink;
