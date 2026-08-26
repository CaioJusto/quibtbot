/**
 * Catálogo puro de onde o **servidor Quibt** fica ligado — distinto do computador dos bots.
 * E2B nunca aparece aqui: ela só isola o desktop de cada bot, não hospeda a API.
 */

export type ServerHostKind = "local" | "vps" | "box";

export type BootstrapPlatform = "linux" | "darwin" | "win32";

export interface ServerHostOption {
  kind: ServerHostKind;
  title: string;
  body: string;
  headline: string;
  what: string;
  who: string;
  youNeed: string[];
  steps: string[];
  cost: string;
  /** Como este host de servidor se relaciona com o computador dos bots depois. */
  botsLater: string;
  signupUrl?: string;
  signupLabel?: string;
  keyUrl?: string;
  keyLabel?: string;
  providerLinks?: Array<{ label: string; url: string }>;
  /** Mostra o comando copiável de bootstrap (VPS). */
  showBootstrapCommand?: boolean;
  /** Oferece instalação direta avançada (Box / SSH em tarefas futuras). */
  showAdvancedSetup?: boolean;
}

const INSTALL_RELEASE = "0.2.12";
const RELEASE_BASE = `https://github.com/CaioJusto/quibtbot/releases/download/v${INSTALL_RELEASE}`;

const LOCAL_HOST: ServerHostOption = {
  kind: "local",
  title: "Neste computador",
  body: "O servidor sobe no Docker deste Mac, Windows ou Linux. Sem VPS nem conta em nuvem.",
  headline: "O servidor Quibt fica neste aparelho",
  what: "Você instala o Quibt no computador que está usando agora. A API, o banco e o supervisor sobem em Docker nesta máquina. Depois, no onboarding, você escolhe onde os bots trabalham — muitas vezes na mesma máquina.",
  who: "Quem quer começar em casa, sozinho ou com gente da mesma casa, sem pagar servidor.",
  youNeed: [
    "Docker Desktop instalado e aberto (o ícone da baleia na barra).",
    "Uns 4 GB livres em disco para as imagens.",
    "Deixar este aparelho ligado enquanto usa o celular. Se desligar, o servidor pausa.",
  ],
  steps: [
    "Instale o Docker Desktop em docker.com e espere ficar “Running”.",
    "No Mac ou Linux deste computador, copie o comando de instalação abaixo e rode no terminal.",
    "Quando terminar, o instalador mostra um QR e um código. Volte ao celular em “Conectar a um Quibt existente”.",
    "Depois de conectar, escolha o modelo e onde os bots trabalham — em geral “Nesta máquina (Docker)”.",
  ],
  cost: "Grátis neste aparelho. Você só paga o modelo (OpenRouter, Ollama local ou a sua assinatura).",
  botsLater:
    "Este passo liga o servidor. O computador dos bots é outra escolha: pode ser o mesmo Docker, uma VPS, E2B ou Box — cada um com regras diferentes de compartilhamento.",
  showBootstrapCommand: true,
};

const VPS_HOST: ServerHostOption = {
  kind: "vps",
  title: "VPS na sua conta",
  body: "Ubuntu 22.04 ou 24.04 num provedor seu. O celular funciona com o notebook desligado.",
  headline: "O servidor Quibt fica na sua VPS",
  what: "Você cria um servidor Ubuntu na Hetzner, DigitalOcean ou equivalente. Um comando sobe tudo: a API, o banco e o computador dos bots, com tela gráfica e navegador. O Quibt roda lá 24 h e o celular fala com a URL pública.",
  who: "Quem já tem VPS ou quer deixar o Quibt ligado sem manter o computador de casa aberto.",
  youNeed: [
    "Uma VPS Ubuntu 22.04 ou 24.04 na sua conta (a Quibt não vende máquina).",
    "Acesso ao console web ou SSH do provedor para colar o comando de instalação.",
    "Depois da instalação: a URL pública do servidor e o código ou QR que o instalador mostrar.",
  ],
  steps: [
    "Entre no console do seu provedor (Hetzner Cloud, DigitalOcean Droplets ou similar).",
    "Crie um servidor Ubuntu 22.04 ou 24.04 — CX22, Droplet de 2 GB ou equivalente.",
    "Abra o console web (ou SSH) como root e cole o comando abaixo. Aguarde o instalador terminar.",
    "Anote a URL e o código que aparecem no terminal. No celular, toque em “Conectar a um Quibt existente”.",
    "Crie o primeiro bot. O computador dele já está de pé — não há mais nada para configurar.",
  ],
  cost: "Você paga a VPS no Hetzner, DigitalOcean etc. A Quibt não cobra a máquina.",
  botsLater:
    "O mesmo comando já sobe o computador dos bots nessa VPS: Linux com tela gráfica e navegador, um monitor por bot, pronto para você ver e assumir pelo celular. Trocar por E2B ou Box continua possível em Ajustes → Máquina, mas não é preciso para começar.",
  providerLinks: [
    {
      label: "Como criar um servidor na Hetzner",
      url: "https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server",
    },
    {
      label: "Como criar um Droplet na DigitalOcean",
      url: "https://docs.digitalocean.com/products/droplets/getting-started/quickstart/",
    },
  ],
  showBootstrapCommand: true,
};

const BOX_HOST: ServerHostOption = {
  kind: "box",
  title: "VM persistente na Box",
  body: "Ubuntu com disco que sobrevive à pausa. Conta e cobrança são seus na Box.",
  headline: "O servidor Quibt fica numa VM Box sua",
  what: "A Box (box.ascii.dev) entrega uma máquina Ubuntu persistente na sua conta. O Quibt instala o servidor lá. Isso é diferente de usar Box só como computador de um bot — aqui a VM hospeda a API.",
  who: "Quem quer servidor sempre ligado sem administrar VPS, e já tem ou quer abrir conta na Box.",
  youNeed: [
    "Uma conta em box.ascii.dev (login com GitHub). O onboarding deles inclui um trial.",
    "A BOX_API_KEY, criada no dashboard da Box ou com `box api-key create`.",
    "Saldo na Box. Eles cobram por segundo na sua conta. A Quibt não cobra a VM.",
  ],
  steps: [
    "Abra box.ascii.dev, crie a conta e entre no dashboard.",
    "Crie uma chave de API em API Keys e guarde em local seguro — ela não vai para a API Quibt.",
    "Use “Instalação direta no Box” abaixo quando disponível, ou siga o guia Box + comando no desktop.",
    "Quando o servidor responder, volte ao celular em “Conectar a um Quibt existente” com a URL e o código.",
    "No onboarding, escolha onde os bots trabalham — VMs Box para bots são outras VMs, não esta do servidor.",
  ],
  cost: "A Box cobra o tempo da VM na sua conta (há trial). A Quibt não revende a máquina.",
  botsLater:
    "Esta VM é só o servidor Quibt. Cada bot pode ganhar outra VM Box depois — disco e login separados.",
  signupUrl: "https://box.ascii.dev/",
  signupLabel: "Criar conta na Box",
  keyUrl: "https://box.ascii.dev/box/dashboard?tab=api-keys",
  keyLabel: "Abrir as chaves da Box",
  showAdvancedSetup: true,
};

const SERVER_HOSTS: ServerHostOption[] = [LOCAL_HOST, VPS_HOST, BOX_HOST];

export function serverHostOptions(): ServerHostOption[] {
  return SERVER_HOSTS.map((item) => ({ ...item }));
}

export function serverHostGuide(kind: ServerHostKind): ServerHostOption {
  const guide = SERVER_HOSTS.find((item) => item.kind === kind);
  if (!guide) return { ...LOCAL_HOST };
  return { ...guide };
}

function linuxBootstrapScript(): string {
  return `set -euo pipefail
BASE="${RELEASE_BASE}"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARTIFACT="quibtbot-linux-x64" ;;
  aarch64|arm64) ARTIFACT="quibtbot-linux-arm64" ;;
  *) echo "unsupported architecture: $ARCH"; exit 1 ;;
esac
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$BASE/$ARTIFACT" -o "$tmpdir/quibtbot"
curl -fsSL "$BASE/$ARTIFACT.sha256" -o "$tmpdir/quibtbot.sha256"
expected=$(awk '{print $1}' "$tmpdir/quibtbot.sha256")
actual=$(sha256sum "$tmpdir/quibtbot" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo "checksum mismatch" >&2; exit 1; }
chmod +x "$tmpdir/quibtbot"
"$tmpdir/quibtbot" install --non-interactive --show-sensitive
`;
}

/**
 * O comando para o computador da pessoa (Mac ou Linux): um script que descobre a
 * arquitetura, baixa o `quibtbot` certo, confere o SHA-256 e roda `quibtbot install`. É o
 * mesmo comando que o site mostra. No Windows o caminho é o app de desktop.
 */
export const INSTALL_SCRIPT_COMMAND = `curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/v${INSTALL_RELEASE}/scripts/install.sh | QUIBT_RELEASE=${INSTALL_RELEASE} sh`;

/** Comando público copiável para subir o servidor Quibt no host escolhido. */
export function bootstrapCommand(platform: BootstrapPlatform): string {
  switch (platform) {
    case "linux":
      return linuxBootstrapScript();
    case "darwin":
      return [
        `curl -fsSL "${RELEASE_BASE}/quibtbot-darwin-arm64" -o /tmp/quibtbot`,
        `curl -fsSL "${RELEASE_BASE}/quibtbot-darwin-arm64.sha256" -o /tmp/quibtbot.sha256`,
        "echo \"$(awk '{print $1}' /tmp/quibtbot.sha256)  /tmp/quibtbot\" | shasum -a 256 -c -",
        "chmod +x /tmp/quibtbot",
        "/tmp/quibtbot install --non-interactive --show-sensitive",
      ].join(" && ");
    case "win32":
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $u='${RELEASE_BASE}/quibtbot-win32-x64.exe'; $p=$env:TEMP+'\\quibtbot.exe'; $s=$p+'.sha256'; Invoke-WebRequest -Uri $u -OutFile $p; Invoke-WebRequest -Uri ($u+'.sha256') -OutFile $s; $expected=((Get-Content $s).Trim() -split '\\s+')[0].ToLower(); $actual=(Get-FileHash -Algorithm SHA256 $p).Hash.ToLower(); if ($actual -ne $expected) { throw 'checksum mismatch' }; & $p install --non-interactive --show-sensitive }"`;
    default:
      return linuxBootstrapScript();
  }
}
