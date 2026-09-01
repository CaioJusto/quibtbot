import { OSS_MACHINE_COPY, type OssMachine, parseOssMachine } from "./edition.js";

/**
 * Plain-language onboarding for the machine the owner just picked.
 *
 * The catalog cards stay short. This is the text that appears after a tap, so a
 * person who is not technical still knows what to do, what they will pay, and
 * how the bots share (or do not share) a computer.
 */
export interface MachineGuide {
  kind: string;
  family: OssMachine;
  title: string;
  body: string;
  headline: string;
  what: string;
  who: string;
  youNeed: string[];
  steps: string[];
  /** How several bots share this machine. Never claims a browser tab per bot. */
  botsShare: string;
  cost: string;
  signupUrl?: string;
  signupLabel?: string;
  keyUrl?: string;
  keyLabel?: string;
}

const DOCKER_GUIDE: MachineGuide = {
  kind: "docker",
  family: "docker",
  title: OSS_MACHINE_COPY.docker.title,
  body: OSS_MACHINE_COPY.docker.body,
  headline: "O computador dos bots fica neste aparelho",
  what: "O Quibt sobe um Linux pequeno no Docker do seu computador. Você não cria conta em nuvem e não cola chave. É o caminho mais simples para começar em casa.",
  who: "Quem vai usar o Quibt neste Mac, Windows ou Linux, sozinho ou com gente da mesma casa.",
  youNeed: [
    "Docker Desktop instalado e aberto (o ícone da baleia na barra). Sem isso o computador do bot não liga.",
    "Espaço em disco: uns 4 GB livres para a imagem do Linux.",
    "Deixar este aparelho ligado enquanto os bots trabalham. Se você desligar, eles pausam. O celular fora deste Wi-Fi só entra se você colar um https:// seu (Cloudflare Tunnel ou Tailscale Funnel) em Ajustes → Celular; o Quibt não hospeda túnel.",
  ],
  steps: [
    "Instale o Docker Desktop em docker.com, abra o app e espere ficar “Running”.",
    "No Quibt, deixe “Nesta máquina (Docker)” selecionado.",
    "Toque em Testar. Se aparecer que o Docker respondeu, toque em Salvar e continuar.",
    "Crie o primeiro bot. Quando você mandar uma mensagem, a tela Linux dele abre no painel do computador.",
  ],
  botsShare:
    "É o mesmo computador (um Linux por workspace, a mesma imagem). Cada bot ganha a própria tela — um desktop gráfico por bot, não é uma aba do Chrome. Os arquivos e alguns logins do navegador são compartilhados. A parede é a mesma; as janelas de cada bot são outras.",
  cost: "Grátis no seu aparelho. Você só paga o modelo (OpenRouter, Ollama local, a sua assinatura ou a sessão de uma CLI no host da API/worker).",
};

const REMOTE_GUIDE: MachineGuide = {
  kind: "remote-supervisor",
  family: "remote-supervisor",
  title: OSS_MACHINE_COPY["remote-supervisor"].title,
  body: OSS_MACHINE_COPY["remote-supervisor"].body,
  headline: "O computador dos bots fica no seu servidor",
  what: "É o mesmo Linux do Docker, só que rodando numa VPS sua (Hetzner, DigitalOcean ou qualquer Ubuntu). O celular e o app continuam funcionando com o notebook desligado.",
  who: "Quem já tem um servidor, ou quer deixar os bots ligados 24 h sem deixar o computador de casa aberto.",
  youNeed: [
    "Uma VPS Ubuntu 22.04 ou 24.04 na sua conta (a Quibt não vende máquina).",
    "O caminho que funciona inteiro é instalar o stack todo na VPS (`quibtbot install`): API, worker, banco, supervisor e tela ficam no mesmo servidor, e não há endereço para colar aqui.",
    "Para usar só o computador noutra máquina, o dono daquele host precisa ligar o profile `supervisor-tls` lá (`docker compose --profile supervisor-tls up -d supervisor supervisor-tls`). A porta do supervisor não é publicada sozinha: quem atende é o Caddy, por https, num nome público.",
    "Nesse modo a tela não chega: o noVNC fica na rede interna do Docker daquele host. Comandos, arquivos e rotinas funcionam; o painel do computador fica preto.",
    "O endereço https desse nome e o token do supervisor — a mesma senha longa que está no .env do servidor.",
  ],
  steps: [
    "Crie a VPS na sua conta (Hetzner CX22, Droplet de 2 GB ou equivalente).",
    "Para o celular alcançar a VPS de qualquer lugar, rode o instalador inteiro nela (`quibtbot install`): com 80 e 443 livres ele tira um certificado HTTPS sozinho, num nome sslip.io — sem domínio seu, sem domínio da Quibt.",
    "Escolha a receita do provedor nesta tela, ou rode o script genérico por SSH.",
    "No servidor, preencha o .env com BETTER_AUTH_SECRET, ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN e BOOTSTRAP_SECRET (cada um com `openssl rand -hex 32`), mais RESEND_API_KEY ou AUTH_EMAIL_DISABLED=true. O Compose roda como produção: valor curto ou ainda começando com `replace-with-` faz o serviço recusar subir.",
    "Cole aqui a URL do supervisor e o mesmo token. Toque em Testar e depois em Salvar.",
    "Para entrar no Quibt que roda na VPS, use senha ou um código de pareamento de um aparelho já conectado: numa instalação que não é deste computador, o Quibt não abre a sessão por conta própria.",
  ],
  botsShare:
    "Igual ao Docker local: um Linux por workspace, um desktop gráfico por bot. Não é uma aba do navegador. A imagem é a mesma; cada bot tem o próprio desktop.",
  cost: "Você paga a VPS no Hetzner, DigitalOcean etc. A Quibt não cobra a máquina.",
};

const E2B_GUIDE: MachineGuide = {
  kind: "e2b",
  family: "e2b",
  title: OSS_MACHINE_COPY.e2b.title,
  body: OSS_MACHINE_COPY.e2b.body,
  headline: "Cada bot ganha um desktop isolado na E2B",
  what: "A E2B aluga um Linux com tela (template Desktop, Xfce) na nuvem deles. Não é o seu Docker. Cada bot tem o próprio sandbox — arquivos e logins não passam de um bot para o outro.",
  who: "Quem não quer instalar Docker, ou vai ter várias pessoas no mesmo deploy e precisa isolar um bot do outro.",
  youNeed: [
    "Uma conta em e2b.dev. Contas novas recebem crédito de boas-vindas no painel deles.",
    "A chave de API (começa com e2b_). Você copia em e2b.dev/dashboard, aba Keys.",
    "Saldo na E2B. A Quibt não cobra nem revende essa máquina.",
  ],
  steps: [
    "Abra e2b.dev, crie a conta e entre no Dashboard.",
    "Vá em Keys, copie a E2B_API_KEY e cole nesta tela.",
    "Toque em Testar. Se a chave for aceita, toque em Salvar e continuar.",
    "Crie o bot. Na primeira mensagem a E2B liga o desktop; o painel do Quibt mostra a tela ao vivo.",
  ],
  botsShare:
    "Não compartilham computador. É um sandbox por bot (um bot = um sandbox E2B), com um desktop e um stream próprios. A E2B não emula “várias telas no mesmo Linux” nem “uma aba por bot”, e nunca hospeda o servidor Quibt — só isola o computador de cada bot. Quando o bot fica quieto, o sandbox pausa; a próxima mensagem ou “Assumir controle” retoma.",
  cost: "A E2B cobra o tempo do sandbox na sua conta. Contas novas ganham crédito; o restante é o preço deles, não da Quibt.",
  signupUrl: "https://e2b.dev/auth/sign-up",
  signupLabel: "Criar conta na E2B",
  keyUrl: "https://e2b.dev/dashboard?tab=keys",
  keyLabel: "Abrir as chaves da E2B",
};

const BOX_GUIDE: MachineGuide = {
  kind: "box",
  family: "box",
  title: OSS_MACHINE_COPY.box.title,
  body: OSS_MACHINE_COPY.box.body,
  headline: "Cada bot ganha uma VM Ubuntu persistente na Box",
  what: "A Box (box.ascii.dev) entrega uma máquina Ubuntu de verdade, com disco que sobrevive quando ela pausa. O desktop aparece no Quibt pelo noVNC. Credenciais do seu servidor Quibt não entram na VM (noEnv).",
  who: "Quem quer um computador que lembra arquivos e programas depois de uma pausa, sem cuidar de VPS.",
  youNeed: [
    "Uma conta em box.ascii.dev (login com GitHub). No trial, cada VM precisa pausar automaticamente em até 2 horas.",
    "A BOX_API_KEY, criada no dashboard da Box ou com `box api-key create`. Se você já instalou o servidor Quibt na Box por este iPhone, a chave salva é reutilizada.",
    "Saldo na Box. Eles cobram por segundo na sua conta. A Quibt não cobra a VM.",
  ],
  steps: [
    "Abra box.ascii.dev, instale o CLI se quiser, ou só entre no dashboard pelo navegador.",
    "Crie uma chave de API e cole nesta tela. Se ela já foi usada na instalação, apenas desbloqueie a chave salva.",
    "Toque em Testar. Se a Box responder, toque em Salvar e continuar.",
    "Crie o bot. A primeira mensagem cria a VM; “Assumir controle” abre o desktop. No trial ela pausa em até 2 horas, preserva o disco e volta do mesmo ponto na próxima mensagem.",
  ],
  botsShare:
    "Não compartilham computador. É uma VM por bot (um bot = uma VM Box). Não é aba de navegador e não é a mesma imagem do Docker local. Cada VM tem o próprio disco; parar arquiva, retomar restaura.",
  cost: "A Box cobra o tempo da VM na sua conta. O trial exige pausa automática em até 2 horas; o Quibt configura isso sozinho e não revende a máquina.",
  signupUrl: "https://box.ascii.dev/",
  signupLabel: "Criar conta na Box",
  keyUrl: "https://box.ascii.dev/box/dashboard?tab=api-keys",
  keyLabel: "Abrir as chaves da Box",
};

const DAYTONA_GUIDE: MachineGuide = {
  kind: "daytona",
  family: "daytona",
  title: OSS_MACHINE_COPY.daytona.title,
  body: OSS_MACHINE_COPY.daytona.body,
  headline: "Cada bot ganha um sandbox com desktop na Daytona",
  what: "A Daytona cria um Linux isolado por bot. O Quibt usa o SDK oficial, inicia o desktop VNC da imagem padrão e abre uma URL temporária assinada no painel do computador.",
  who: "Quem quer terminal, arquivos e desktop gráfico na nuvem sem instalar Docker no servidor Quibt.",
  youNeed: [
    "Uma conta em daytona.io.",
    "A DAYTONA_API_KEY criada no dashboard. DAYTONA_API_URL e DAYTONA_TARGET só são necessários em instalações self-host/customizadas.",
    "Crédito ou plano na Daytona. A Quibt não cobra nem revende o sandbox.",
  ],
  steps: [
    "Abra app.daytona.io, entre na sua conta e crie uma API key.",
    "Cole a DAYTONA_API_KEY nesta tela e toque em Testar.",
    "Salve e crie o bot. A primeira mensagem cria o sandbox e inicia o desktop.",
    "Use Assumir controle para abrir o noVNC por uma URL assinada; o link expira e é revogado ao fechar.",
  ],
  botsShare:
    "Não compartilham computador. É um sandbox Daytona por bot, com filesystem, processos e desktop próprios. Não é aba de navegador. Parar preserva o disco; excluir o bot apaga o sandbox.",
  cost: "A Daytona cobra o sandbox na sua conta. A Quibt não revende essa infraestrutura.",
  signupUrl: "https://app.daytona.io/",
  signupLabel: "Abrir a Daytona",
  keyUrl: "https://app.daytona.io/dashboard/keys",
  keyLabel: "Abrir as chaves da Daytona",
};

const HETZNER_GUIDE: MachineGuide = {
  ...REMOTE_GUIDE,
  kind: "vps-hetzner",
  title: "Hetzner (receita)",
  body: "Crie um CX22 com o token da sua conta Hetzner, ou rode o script na VM. A Quibt não cobra a máquina.",
  headline: "Receita Hetzner: o computador fica na sua CX22",
  steps: [
    "Crie uma conta em hetzner.com e um servidor Cloud CX22, Ubuntu 24.04.",
    "Cole o script desta tela no cloud-init, ou entre por SSH e rode o script.",
    "No servidor, edite /opt/quibt-bot/.env: BETTER_AUTH_SECRET, ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN e BOOTSTRAP_SECRET, mais RESEND_API_KEY ou AUTH_EMAIL_DISABLED=true. O Compose roda como produção e recusa valor de exemplo (`replace-with-`). Depois suba o Compose.",
    "Volte aqui, cole a URL do supervisor e o token, teste e salve.",
    "Na VPS você entra por senha ou por código de pareamento — a entrada automática só existe no computador onde o Quibt roda.",
  ],
  signupUrl: "https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server",
  signupLabel: "Como criar um servidor na Hetzner",
};

const DIGITALOCEAN_GUIDE: MachineGuide = {
  ...REMOTE_GUIDE,
  kind: "vps-digitalocean",
  title: "DigitalOcean (receita)",
  body: "Droplet Ubuntu com Docker + Compose. Use o token da sua conta DigitalOcean — a Quibt não revende VPS.",
  headline: "Receita DigitalOcean: o computador fica no seu Droplet",
  steps: [
    "Crie um Droplet Ubuntu 24.04 com pelo menos 2 GB de RAM na sua conta DigitalOcean.",
    "Rode o script desta tela no Droplet (SSH ou user-data).",
    "Preencha o .env: BETTER_AUTH_SECRET, ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN e BOOTSTRAP_SECRET, mais RESEND_API_KEY ou AUTH_EMAIL_DISABLED=true. O Compose roda como produção e recusa os valores `replace-with-` do exemplo. Depois suba o Compose.",
    "Cole a URL do supervisor e o token, teste e salve.",
    "Para entrar depois, use senha ou código de pareamento: fora do computador local não existe entrada automática.",
  ],
  signupUrl: "https://docs.digitalocean.com/products/droplets/how-to/create/",
  signupLabel: "Como criar um Droplet",
};

const GENERIC_VPS_GUIDE: MachineGuide = {
  ...REMOTE_GUIDE,
  kind: "vps-generic",
  title: "Qualquer VPS (script)",
  body: "Ubuntu com Docker. O script instala o stack; você cola a URL do supervisor quando ele responder.",
  headline: "Qualquer Ubuntu: o computador fica no servidor que você já tem",
  steps: [
    "Pegue um Ubuntu 22.04 ou 24.04 com IP público (Oracle, Linode, Vultr, o que for).",
    "Rode o script desta tela como root.",
    "Edite o .env (BETTER_AUTH_SECRET, ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN, BOOTSTRAP_SECRET, e RESEND_API_KEY ou AUTH_EMAIL_DISABLED=true; nada de `replace-with-`, porque o Compose roda como produção), suba o Compose, abra só a porta do app (443 ou 5173). O supervisor fica interno, com token.",
    "Cole a URL e o token aqui, teste e salve.",
    "Você entra nessa instalação por senha ou por código de pareamento; a entrada automática existe só no computador onde o Quibt roda.",
  ],
};

const GUIDES: Record<string, MachineGuide> = {
  docker: DOCKER_GUIDE,
  "remote-supervisor": REMOTE_GUIDE,
  e2b: E2B_GUIDE,
  box: BOX_GUIDE,
  daytona: DAYTONA_GUIDE,
  "vps-hetzner": HETZNER_GUIDE,
  "vps-digitalocean": DIGITALOCEAN_GUIDE,
  "vps-generic": GENERIC_VPS_GUIDE,
};

const FAMILY_GUIDES: Record<OssMachine, MachineGuide> = {
  docker: DOCKER_GUIDE,
  "remote-supervisor": REMOTE_GUIDE,
  e2b: E2B_GUIDE,
  box: BOX_GUIDE,
  daytona: DAYTONA_GUIDE,
};

/** Exact catalog kind first, then the bootable family, then Docker. */
export function machineGuideFor(kind: string | undefined | null): MachineGuide {
  const raw = (kind ?? "").trim().toLowerCase();
  if (raw && GUIDES[raw]) return GUIDES[raw];
  const family = parseOssMachine(raw);
  if (family && FAMILY_GUIDES[family]) return FAMILY_GUIDES[family];
  return DOCKER_GUIDE;
}

export function listMachineGuides(): MachineGuide[] {
  return Object.values(GUIDES);
}
