/**
 * Os passos de ligar o computador, ditos por nome.
 *
 * Antes a tela mostrava só "Ligando…" com uma barra parada em dois terços — um número
 * inventado, que dizia a mesma coisa aos cinco segundos e aos dois minutos. Aqui não há
 * porcentagem: o servidor não manda progresso, então a tela só nomeia em que passo o
 * computador está, usando o estado que o `computer/status` já devolve.
 *
 * Nenhum campo novo de contrato entra aqui. Se um dia o estado parar num passo, a pessoa
 * ao menos vê em qual — e isso é o que ela pode contar para quem for ajudar.
 */

export type ComputerState = "stopped" | "booting" | "running" | "suspended" | "error";

export type BootStepState = "done" | "doing" | "waiting" | "failed";

export type BootStep = {
  id: "pedido" | "maquina" | "tela" | "entrada";
  label: string;
  state: BootStepState;
};

export type BootProgressInput = {
  /** O estado do `computer/status` mais recente; `null` enquanto a primeira resposta não voltou. */
  state?: ComputerState | null;
  screenAvailable?: boolean;
  /** A URL assinada da tela, quando o cliente já a tem em mãos. */
  screenUrl?: string | null;
};

/**
 * Quantos passos já passaram. É a única ordenação que existe: cada passo só pode estar
 * "feito" porque o estado seguinte chegou, nunca porque o tempo passou.
 */
function stepsDone(input: BootProgressInput): number {
  const state = input.state ?? null;
  if (state === null) return 0;
  if (state === "stopped" || state === "booting" || state === "suspended") return 1;
  // "running" é a máquina de pé: o pedido saiu e a máquina ligou.
  if (state === "running") {
    if (!input.screenAvailable) return 2;
    return input.screenUrl ? 4 : 3;
  }
  // "error": o passo que estava andando é o que falhou; qual foi, o estado não conta.
  return 1;
}

function machineLabel(state: ComputerState | null): string {
  return state === "suspended" ? "Acordando a máquina" : "Ligando a máquina";
}

/**
 * A lista de passos como a tela desenha: o primeiro ainda não terminado é o que está
 * andando, os de baixo esperam. Só um passo anda por vez.
 */
export function bootSteps(input: BootProgressInput): BootStep[] {
  const state = input.state ?? null;
  const done = stepsDone(input);
  const failed = state === "error";
  const labels: Array<Pick<BootStep, "id" | "label">> = [
    { id: "pedido", label: "Pedindo o computador" },
    { id: "maquina", label: machineLabel(state) },
    { id: "tela", label: "Preparando a tela do bot" },
    { id: "entrada", label: "Abrindo a tela aqui dentro" },
  ];
  return labels.map((step, index) => {
    if (index < done) return { ...step, state: "done" };
    if (index === done) return { ...step, state: failed ? "failed" : "doing" };
    return { ...step, state: "waiting" };
  });
}

/** Se já não há passo andando: a tela está pronta e o overlay de ligar pode sair. */
export function bootFinished(input: BootProgressInput): boolean {
  return stepsDone(input) >= 4;
}

/**
 * A mesma verdade em uma linha só, para os cantos onde não cabe a lista. Substitui o
 * "Ligando o computador…" fixo, que continuava igual mesmo depois da máquina subir.
 */
export function bootStatusLine(input: BootProgressInput): string {
  if (input.state === "error") return "O computador não conseguiu ligar.";
  const current = bootSteps(input).find((step) => step.state === "doing");
  return current ? `${current.label}…` : "Tela pronta.";
}
