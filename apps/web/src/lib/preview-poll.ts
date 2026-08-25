/**
 * A tela do bot sem o controle: a capacidade do noVNC é interativa e só vai para quem tem
 * o lease, mas o retrato parado (`computer.preview`) não exige nada. Enquanto o bot
 * trabalha, o painel pede um retrato a cada 3 s — o mesmo TTL do cache da API, então
 * pedir mais rápido só devolveria a mesma imagem — e mostra a última no lugar da
 * ilustração de mesa. Aqui fica só a decisão: quando pedir, com que intervalo e como
 * rotular a idade do retrato. Quem chama cuida do timer e do estado.
 */

/** TTL do cache de `computer.preview` na API: um retrato novo a cada 3 s, no máximo. */
export const PREVIEW_POLL_MS = 3_000;
/** Depois de uma falha, espera o dobro a cada tentativa até o teto. */
export const PREVIEW_RETRY_MAX_MS = 30_000;

export type PreviewPollInput = {
  state: string | null | undefined;
  controlHolder: string | null | undefined;
  /** Painel lateral do computador ou a tela cheia à vista. */
  shown: boolean;
  /** `document.visibilityState === "hidden"`: aba em segundo plano. */
  hidden: boolean;
  /** Já há um iframe noVNC montado: a tela de verdade dispensa o retrato. */
  streaming: boolean;
};

/**
 * Pede retratos só quando alguém está olhando e não há coisa melhor para mostrar:
 * computador ligado, painel à vista, aba em primeiro plano, e o controle não é do usuário
 * (com o controle o iframe assume; sem ele não há URL, então é o retrato ou nada).
 */
export function shouldPollPreview(input: PreviewPollInput): boolean {
  if (input.state !== "running") return false;
  if (!input.shown || input.hidden) return false;
  if (input.controlHolder === "user") return false;
  if (input.streaming) return false;
  return true;
}

/**
 * Intervalo até o próximo pedido. Sem falhas, o TTL do cache; a cada falha seguida o
 * intervalo dobra (6 s, 12 s, 24 s…) até o teto, para não martelar um computador que não
 * responde. Volta ao normal na primeira resposta boa.
 */
export function previewPollDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return PREVIEW_POLL_MS;
  return Math.min(PREVIEW_POLL_MS * 2 ** Math.min(failures, 30), PREVIEW_RETRY_MAX_MS);
}

export type PreviewFrame = {
  image: string;
  /** Quando a API tirou o retrato (relógio do servidor); `null` quando não informou. */
  capturedAt: string | null;
  /** Quando este cliente recebeu o retrato (relógio local). */
  receivedAt: number;
};

/**
 * Idade do retrato em milissegundos, pelo relógio local. A parte do servidor (quanto o
 * cache já tinha de idade quando entregou) é medida pela diferença `receivedAt −
 * capturedAt` e limitada ao TTL, porque os relógios podem divergir e um desvio de
 * minutos viraria um "há 400s" mentiroso. Sem `capturedAt` válido, conta do recebimento.
 */
export function previewAgeMs(
  frame: Pick<PreviewFrame, "capturedAt" | "receivedAt">,
  now: number,
): number {
  const sinceReceived = Math.max(0, now - frame.receivedAt);
  const captured = frame.capturedAt ? Date.parse(frame.capturedAt) : Number.NaN;
  if (!Number.isFinite(captured)) return sinceReceived;
  const serverAge = Math.min(Math.max(0, frame.receivedAt - captured), PREVIEW_POLL_MS);
  return sinceReceived + serverAge;
}

/**
 * O selo sobre a imagem: "ao vivo · agora" no primeiro segundo, "ao vivo · há 4s" depois.
 * Passado um minuto sem retrato novo já não é ao vivo — vira "há 1min" sem o selo, para
 * ninguém tomar uma tela velha por atual.
 */
export function previewAgeLabel(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 1) return "ao vivo · agora";
  if (seconds < 60) return `ao vivo · há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `há ${minutes}min`;
}
