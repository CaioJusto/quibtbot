/**
 * A parte pura da aparência (claro/escuro/sistema): validação e rótulos, sem tocar em
 * react-native — é o que os testes conseguem importar. O glue nativo mora em
 * appearance.ts.
 */
export type AppearanceChoice = "system" | "light" | "dark";

export function isAppearanceChoice(value: unknown): value is AppearanceChoice {
  return value === "system" || value === "light" || value === "dark";
}

export function appearanceLabel(choice: AppearanceChoice): string {
  return choice === "light" ? "Claro" : choice === "dark" ? "Escuro" : "Sistema";
}
