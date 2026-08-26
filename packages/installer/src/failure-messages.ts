/** Em que passo o Docker falhou: a mesma palavra quer dizer coisas diferentes nos dois. */
export type DockerFailurePhase = "pull" | "up";

export interface DockerFailureContext {
  /** Sem contexto vale o download, que é de onde vem a maioria destas saídas. */
  phase?: DockerFailurePhase;
  /** A pasta de dados, para a frase do bind mount dizer qual pasta liberar. */
  dataDir?: string;
}

/** O Docker Desktop sumiu entre uma sessão e outra: religar não pode reinstalá-lo. */
export const DOCKER_DESKTOP_GONE_MESSAGE =
  "O Docker Desktop não está mais instalado neste computador. Rode a instalação de novo para o Quibt baixar o Docker.";

/**
 * O stderr do Docker é para quem sabe ler Docker. Quem instala o Quibt Bot num Mac de
 * casa vê "Cannot connect to the Docker daemon at unix:///…" e não sabe que basta abrir
 * a baleia. Aqui a causa vira uma frase com ação; o texto cru continua indo para os
 * detalhes técnicos.
 *
 * A fase importa: "denied" num `pull` é o registro recusando a imagem, mas num `up` é
 * quase sempre o Docker Desktop sem permissão para a pasta de dados — mandar esperar o
 * ghcr.io voltar ali é mandar o usuário para o lugar errado.
 */
export function explainDockerFailure(
  output: string,
  context: DockerFailureContext = {},
): string | null {
  const text = output.trim();
  if (!text) return null;

  if (
    /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker desktop is (?:starting|stopped|paused)|the docker daemon is not running/i.test(
      text,
    )
  ) {
    return "O Docker não está respondendo. Abra o Docker Desktop (a baleia) e tente de novo.";
  }

  const port =
    /(?:port is already allocated|address already in use|bind for [^ ]*:(\d+) failed)/i.exec(text);
  if (port) {
    const number = port[1] ?? /:(\d{2,5})\b/.exec(text)?.[1];
    return number
      ? `A porta ${number} já está em uso por outro programa neste computador. Feche esse programa (ou o outro Quibt) e tente de novo.`
      : "Uma porta que o Quibt precisa já está em uso por outro programa. Feche esse programa e tente de novo.";
  }

  if (/no space left on device/i.test(text)) {
    return "O disco encheu durante o download. Libere espaço e tente de novo — o que já baixou fica guardado.";
  }

  if (context.phase === "up") {
    const denied = mountDeniedMessage(text, context.dataDir);
    if (denied) return denied;
    return null;
  }

  if (
    /no such host|TLS handshake timeout|i\/o timeout|connection refused|connection reset|network is unreachable|context deadline exceeded|unexpected EOF|temporary failure in name resolution|dial tcp/i.test(
      text,
    )
  ) {
    return "A internet falhou no meio do download. Confira a conexão e tente de novo — o que já baixou fica guardado.";
  }

  if (
    /pull access denied|requested access to the resource is denied|unauthorized|manifest unknown|not found: manifest/i.test(
      text,
    )
  ) {
    return "O registro de imagens (ghcr.io) recusou o download. Tente de novo mais tarde; se continuar, avise a equipe do Quibt.";
  }

  return null;
}

/**
 * "Mounts denied: The path … is not shared from the host" (Docker Desktop no Mac) e o
 * "permission denied" de um volume no Linux dizem a mesma coisa: o Docker não alcança a
 * pasta de dados. O "permission denied" do socket não entra aqui — esse é outro problema.
 */
function mountDeniedMessage(text: string, dataDir?: string): string | null {
  const socketProblem = /docker\.sock|docker daemon socket/i.test(text);
  const mountProblem =
    /Mounts denied|is not shared from the host|error while creating mount source path/i.test(
      text,
    ) ||
    (/permission denied/i.test(text) && !socketProblem);
  if (!mountProblem) return null;
  const declared = /The path (.+?) is not shared/i.exec(text)?.[1]?.trim();
  const folder = declared || dataDir?.trim();
  const where = folder ? ` ${folder}` : " do Quibt";
  return `O Docker não conseguiu acessar a pasta de dados${where}: no Docker Desktop, libere a pasta em Settings → Resources → File sharing e tente de novo.`;
}

/** Outra instalação segurando a trava: a frase do lock é técnica, esta diz o que fazer. */
export function explainInstallLock(lockMessage: string): string {
  const pid = /pid (\d+)/.exec(lockMessage)?.[1];
  return pid
    ? `Outra instalação ou atualização do Quibt já está em andamento (processo ${pid}). Espere ela terminar ou feche o outro instalador e tente de novo.`
    : "Outra instalação ou atualização do Quibt já está em andamento. Espere ela terminar ou feche o outro instalador e tente de novo.";
}

export function explainUpdateRequired(installedRelease: string, embeddedRelease: string): string {
  return `Este computador tem o Quibt Bot ${installedRelease} instalado e este instalador é o ${embeddedRelease}. Rode a atualização (quibtbot update) em vez de instalar de novo.`;
}
