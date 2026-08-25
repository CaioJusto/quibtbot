/**
 * O que a instalação por SSH diz quando dá errado.
 *
 * O módulo nativo devolve um punhado de frases em inglês, e uma delas mente por
 * omissão: quando o telefone não consegue nem abrir a sessão — endereço errado,
 * porta fechada, servidor desligado —, o iOS e o Android respondem "SSH host
 * fingerprint was not returned", como se o problema fosse a impressão digital.
 * Quem lê isso vai conferir a chave do servidor e não o que está de fato quebrado.
 */

export type SshTarget = { host: string; port: number };

function where(target: SshTarget): string {
  return `${target.host}:${target.port}`;
}

export function sshSetupErrorMessage(error: unknown, target: SshTarget): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.toLowerCase();

  if (text.includes("verified ssh is unavailable")) {
    return "Este app foi montado sem o módulo de SSH verificado. Instale a versão nova do app para instalar numa VPS.";
  }
  if (text.includes("fingerprint mismatch")) {
    return `A identidade de ${where(target)} mudou desde a última vez. Se você não reinstalou o servidor, pare: alguém pode estar no meio da conexão.`;
  }
  // libssh2 1.8 (a lib de SSH do app no iOS) só conhece chaves de host `ssh-rsa` e
  // `ssh-dss`, ambas aposentadas por padrão no OpenSSH 8.8+. Contra um Ubuntu 22.04, que
  // só oferece rsa-sha2/ecdsa/ed25519, não há algoritmo em comum e o aperto de mão morre
  // antes de qualquer senha. Não adianta o dono conferir endereço nem porta.
  if (
    text.includes("exchange encryption keys") ||
    text.includes("key exchange") ||
    text.includes("no matching") ||
    text.includes("host key")
  ) {
    return `${where(target)} usa uma criptografia mais nova do que o SSH deste app entende. Instale pelo computador (app do Mac/Windows) ou rode o instalador dentro da própria VPS.`;
  }
  if (text.includes("fingerprint was not returned") || text.includes("inspect_failed")) {
    return `Não consegui abrir uma sessão SSH com ${where(target)}. Confira o endereço e a porta, se o servidor está ligado e se o SSH aceita conexão de fora.`;
  }
  if (text.includes("connection failed") || text.includes("connect_failed")) {
    return `Não consegui conectar em ${where(target)}. O endereço pode estar errado, a porta fechada ou o firewall barrando este telefone.`;
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return `${where(target)} não respondeu a tempo. Costuma ser firewall ou o servidor fora do ar.`;
  }
  if (
    text.includes("authentication") ||
    text.includes("auth fail") ||
    text.includes("permission denied")
  ) {
    return "O servidor recusou o login. Confira o usuário e a senha, ou se a chave privada é a que ele conhece.";
  }
  // Uma mensagem que já veio em português é do nosso próprio código e está pronta.
  return raw.trim() || "Não foi possível instalar por SSH.";
}
