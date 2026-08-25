/**
 * Traduz o que a pessoa digita no celular para as teclas que a máquina entende.
 *
 * O teclado do iOS entrega texto, não teclas: quem digita "oi" e apaga uma letra gera
 * uma sequência de valores, não eventos. Comparar o texto de antes com o de agora diz
 * o que aconteceu de fato — quantos backspaces e o que foi escrito depois deles.
 */

export type KeyStroke = { key: string };

/** Nome que o servidor de teclas espera para apagar e para quebrar linha. */
export const BACKSPACE = "BackSpace";
export const RETURN = "Return";

/**
 * O prefixo comum some dos dois lados: o que sobra do texto antigo vira backspace, e o
 * que sobra do novo vira digitação. Um espaço no meio, ou uma palavra trocada pelo
 * corretor, sai com o mínimo de teclas em vez de apagar tudo e reescrever.
 */
export function strokesForEdit(before: string, after: string): KeyStroke[] {
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) {
    shared += 1;
  }
  const strokes: KeyStroke[] = [];
  for (let i = 0; i < before.length - shared; i += 1) strokes.push({ key: BACKSPACE });
  for (const letter of after.slice(shared)) {
    strokes.push({ key: letter === "\n" ? RETURN : letter });
  }
  return strokes;
}

/** Teto por edição: um colar gigante viraria centenas de chamadas em sequência. */
export const MAX_STROKES_PER_EDIT = 120;

export function boundedStrokes(strokes: KeyStroke[]): KeyStroke[] {
  return strokes.slice(0, MAX_STROKES_PER_EDIT);
}
