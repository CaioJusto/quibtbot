/**
 * Ensinar uma tarefa: a pessoa assume o computador do bot, faz o trabalho uma vez e
 * o bot guarda o método como skill.
 *
 * A captura é de texto, não de pixels, e isso é escolha: o histórico do runtime é
 * texto, então vídeo ou print da sessão não chegariam ao modelo. O que chega — as
 * URLs abertas, os comandos rodados, os arquivos que nasceram — é o que se repete.
 *
 * Esta metade é pura porque o app também precisa dela: o texto do pedido aparece no
 * campo de mensagem para a pessoa ler e corrigir antes de virar skill.
 */

export interface LessonCapture {
  urls: string[];
  commands: string[];
  files: string[];
  windows: string[];
  startedAt?: string;
  error?: string;
}

/**
 * Marca o ponto de partida. O `.bash_history` não guarda hora por padrão, então o que
 * separa "o que a pessoa fez agora" de "o que já estava lá" é o tamanho dele no
 * início — daí guardar a contagem de linhas junto do relógio.
 */

/**
 * O pedido que chega ao bot. O que a pessoa escreveu vem primeiro e manda: a captura é
 * apoio, e pode conter passo em falso — abrir a aba errada, um comando digitado torto.
 * Por isso o texto pede o método, não a transcrição.
 */
export function lessonIsEmpty(capture: LessonCapture): boolean {
  return capture.urls.length === 0 && capture.commands.length === 0 && capture.files.length === 0;
}

/**
 * O pedido que chega ao bot. O que a pessoa escreveu vem primeiro e manda: a captura é
 * apoio, e pode conter passo em falso — abrir a aba errada, um comando digitado torto.
 * Por isso o texto pede o método, não a transcrição.
 */
export function lessonPrompt(notes: string, capture: LessonCapture): string {
  const parts: string[] = [];
  const trimmed = notes.trim();
  parts.push(
    trimmed
      ? `Acabei de te ensinar uma tarefa no seu computador. Com as minhas palavras: ${trimmed}`
      : "Acabei de te ensinar uma tarefa no seu computador, fazendo ela uma vez na sua tela.",
  );
  if (capture.urls.length) parts.push(`Páginas que abri:\n${bullets(capture.urls)}`);
  if (capture.commands.length) parts.push(`Comandos que rodei:\n${bullets(capture.commands)}`);
  if (capture.files.length) parts.push(`Arquivos que mexi:\n${bullets(capture.files)}`);
  parts.push(
    "Escreva o passo a passo para repetir isso sozinho e salve com save_skill, " +
      "num nome curto que eu possa chamar depois. Deixe claro o que fazer, o que " +
      "esperar no fim e o que exige a minha aprovação. Se algo do que eu fiz parecer " +
      "engano ou caminho torto, ignore e escreva o jeito certo. Depois me diga em uma " +
      "linha o nome que ficou.",
  );
  return parts.join("\n\n");
}

function bullets(rows: string[]): string {
  return rows.map((row) => `- ${row}`).join("\n");
}
