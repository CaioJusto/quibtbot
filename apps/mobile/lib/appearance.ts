/**
 * Modo claro / escuro / sistema, escolhido pela pessoa e lembrado no aparelho.
 *
 * A paleta em si vira dinâmica no iOS via `DynamicColorIOS` (cada cor sabe as duas
 * versões); aqui mora só a preferência e o `Appearance.setColorScheme`, que é o que
 * faz o sistema entregar a versão certa de cada cor — e o que o seletor em Conta mexe.
 */
import * as SecureStore from "expo-secure-store";
import { Appearance, type ColorSchemeName, Platform } from "react-native";
import { type AppearanceChoice, isAppearanceChoice } from "./appearance-core";

export { type AppearanceChoice, appearanceLabel, isAppearanceChoice } from "./appearance-core";

const KEY = "quibt.appearance";

export function applyAppearance(choice: AppearanceChoice): void {
  // A paleta customizada usa DynamicColorIOS. Android permanece claro até ter o mesmo
  // sistema de cores dinâmicas; não mude só o cromo nativo e deixe 32 telas claras.
  if (Platform.OS !== "ios") return;
  if (typeof Appearance.setColorScheme !== "function") return;
  Appearance.setColorScheme((choice === "system" ? null : choice) as ColorSchemeName);
}

export async function loadAppearance(): Promise<AppearanceChoice> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    return isAppearanceChoice(stored) ? stored : "system";
  } catch {
    // SecureStore não existe em alguns hosts de teste/web; o padrão é seguir o sistema.
    return "system";
  }
}

export async function saveAppearance(choice: AppearanceChoice): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, choice);
  } catch {
    // Sem storage, a escolha vale só até fechar o app.
  }
}
