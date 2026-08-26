/**
 * A tela do bot sem o controle: a capacidade do noVNC é interativa e só vai para quem tem
 * o lease, mas o retrato parado (`computer.preview`) não exige nada. Enquanto o bot
 * trabalha, o painel pede um retrato a cada 3 s — o mesmo TTL do cache da API, então
 * pedir mais rápido só devolveria a mesma imagem — e mostra a última no lugar da
 * ilustração de mesa. Aqui ficam a decisão (quando pedir, com que intervalo, como rotular
 * a idade) e o laço em si, sem React: quem chama passa o relógio e recebe os retratos.
 */

/** TTL do cache de `computer.preview` na API: um retrato novo a cada 3 s, no máximo. */
export const PREVIEW_POLL_MS = 3_000;
/** Depois de uma falha, espera o dobro a cada tentativa até o teto. */
export const PREVIEW_RETRY_MAX_MS = 30_000;
/**
 * Um retrato mais velho que isto já não representa a tela: some, e volta a ilustração
 * com "sem prévia". Até lá o último retrato fica, envelhecendo no selo.
 */
export const PREVIEW_STALE_MS = 60_000;

export type PreviewPollInput = {
  state: string | null | undefined;
  /** `desktop.controlHolder` do banco: de quem é o lease, não se é deste cliente. */
  controlHolder: string | null | undefined;
  /** A URL da tela: a API só a entrega a quem tem o lease, então é ela que diz "é meu". */
  screenUrl: string | null | undefined;
  /** Painel lateral do computador ou a tela cheia à vista. */
  shown: boolean;
  /** `document.visibilityState === "hidden"`: aba em segundo plano. */
  hidden: boolean;
  /** Já há um iframe noVNC montado: a tela de verdade dispensa o retrato. */
  streaming: boolean;
  /** O stream caiu e esgotou as tentativas: a pessoa ainda tem o lease, o painel avisa. */
  screenLost: boolean;
};

/**
 * "O controle é meu": `controlHolder` vale "user" para qualquer pessoa da workspace
 * enquanto alguém tiver o lease, mas a API só devolve `screenUrl` a quem o tem. Sem a
 * URL, é outra pessoa no controle — e para esta tela não há stream, só o retrato.
 */
export function holdsComputerControl(
  input: Pick<PreviewPollInput, "controlHolder" | "screenUrl">,
): boolean {
  return input.controlHolder === "user" && Boolean(input.screenUrl);
}

/**
 * "Outra pessoa da workspace está com o computador": o lease é de usuário e não é meu.
 * Só vale com a tela de pé — enquanto o computador liga, o lease já pode ser meu sem que
 * a URL exista ainda, e dizer "outra pessoa" ali seria mentir para quem acabou de assumir.
 */
export function othersHoldControl(
  input: Pick<PreviewPollInput, "controlHolder" | "screenUrl" | "state">,
): boolean {
  if (input.state !== "running") return false;
  return input.controlHolder === "user" && !holdsComputerControl(input);
}

/**
 * Pede retratos só quando alguém está olhando e não há coisa melhor para mostrar:
 * computador ligado, painel à vista, aba em primeiro plano, e o controle não é deste
 * cliente (com o controle o iframe assume; sem ele não há URL, então é o retrato ou nada).
 */
export function shouldPollPreview(input: PreviewPollInput): boolean {
  if (input.state !== "running") return false;
  if (!input.shown || input.hidden) return false;
  if (holdsComputerControl(input)) return false;
  if (input.streaming || input.screenLost) return false;
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

/** O que `computer.preview` devolve: um PNG em data URL, ou nada. */
export type PreviewResponse = {
  image: string | null;
  capturedAt: string | null;
};

export type PreviewPollerOptions = {
  fetch: () => Promise<PreviewResponse>;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  now?: () => number;
  /** Um retrato chegou: zera o backoff. */
  onFrame: (frame: PreviewFrame) => void;
  /** A tentativa falhou (erro ou `image: null`); `failures` é a sequência atual. */
  onFailure: (failures: number) => void;
};

export type PreviewPoller = {
  /** Para o laço: cancela o timer e descarta a resposta em voo, se houver. */
  stop: () => void;
};

/**
 * O laço de retratos: pede um agora, entrega pelo `onFrame`, espera o intervalo (com o
 * backoff das falhas) e pede de novo — nunca dois pedidos ao mesmo tempo. Uma falha não
 * apaga nada aqui: quem mostra decide manter o último retrato (e mantém, até ele
 * envelhecer demais). `stop()` vale também no meio de um pedido: a resposta é descartada
 * e nenhum tick novo é agendado.
 */
export function createPreviewPoller(options: PreviewPollerOptions): PreviewPoller {
  const now = options.now ?? (() => Date.now());
  let alive = true;
  let failures = 0;
  let timer: number | null = null;
  const tick = async () => {
    timer = null;
    try {
      const result = await options.fetch();
      if (!alive) return;
      if (result.image) {
        failures = 0;
        options.onFrame({
          image: result.image,
          capturedAt: result.capturedAt,
          receivedAt: now(),
        });
      } else {
        failures += 1;
        options.onFailure(failures);
      }
    } catch {
      if (!alive) return;
      failures += 1;
      options.onFailure(failures);
    }
    if (alive) timer = options.setTimeout(() => void tick(), previewPollDelayMs(failures));
  };
  void tick();
  return {
    stop: () => {
      alive = false;
      if (timer !== null) {
        options.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

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

/** Passou de um minuto sem retrato novo: não vale mais mostrar como se fosse a tela. */
export function previewIsStale(ageMs: number): boolean {
  return ageMs > PREVIEW_STALE_MS;
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
