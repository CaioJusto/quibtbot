/**
 * As frases do instalador também saem num terminal — `quibtbot install` numa VPS, o
 * celular instalando por SSH — e por isso mandam "rode a instalação de novo", que lá é
 * a única instrução possível. Aqui existe um botão com nome: a mesma frase o cita.
 */
export function withDesktopRetryHint(message: string): string {
  return message
    .replace("Rode a instalação de novo", "Clique em Começar instalação")
    .replace("rode a instalação de novo", "clique em Começar instalação de novo");
}
