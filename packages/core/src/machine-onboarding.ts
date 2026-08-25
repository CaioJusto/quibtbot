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
  cost: "Grátis no seu aparelho. Você só paga o modelo (OpenRouter, Ollama local ou a sua assinatura).",
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
    "A URL do supervisor, em geral https://seu-servidor:7091, depois que o script terminar.",
    "O token do supervisor — a senha longa que você colocou no .env do servidor.",
  ],
  steps: [
    "Crie a VPS na sua conta (Hetzner CX22, Droplet de 2 GB ou equivalente).",
    "Para o celular alcançar a VPS de qualquer lugar, rode o instalador inteiro nela (`quibtbot install`): com 80 e 443 livres ele tira um certificado HTTPS sozinho, num nome sslip.io — sem domínio seu, sem domínio da Quibt.",
    "Escolha a receita do provedor nesta tela, ou rode o script genérico por SSH.",
    "No servidor, preencha BETTER_AUTH_SECRET, ENCRYPTION_KEY e SANDBOX_SUPERVISOR_TOKEN no .env e suba o Compose.",
    "Cole aqui a URL do supervisor e o mesmo token. Toque em Testar e depois em Salvar.",
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
    "Uma conta em box.ascii.dev (login com GitHub). O onboarding deles inclui um trial.",
    "A BOX_API_KEY, criada no dashboard da Box ou com `box api-key create`.",
    "Saldo na Box. Eles cobram por segundo na sua conta. A Quibt não cobra a VM.",
  ],
  steps: [
    "Abra box.ascii.dev, instale o CLI se quiser, ou só entre no dashboard pelo navegador.",
    "Crie uma chave de API e cole nesta tela.",
    "Toque em Testar. Se a Box responder, toque em Salvar e continuar.",
    "Crie o bot. A primeira mensagem cria a VM; “Assumir controle” abre o desktop. Se ficar ociosa, ela arquiva o disco e volta do mesmo ponto.",
  ],
  botsShare:
    "Não compartilham computador. É uma VM por bot (um bot = uma VM Box). Não é aba de navegador e não é a mesma imagem do Docker local. Cada VM tem o próprio disco; parar arquiva, retomar restaura.",
  cost: "A Box cobra o tempo da VM na sua conta (há trial). A Quibt não revende a máquina.",
  signupUrl: "https://box.ascii.dev/",
  signupLabel: "Criar conta na Box",
  keyUrl: "https://box.ascii.dev/box/dashboard?tab=api-keys",
  keyLabel: "Abrir as chaves da Box",
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
    "No servidor, edite /opt/quibt-bot/.env (segredos + SANDBOX_SUPERVISOR_TOKEN) e suba o Compose.",
    "Volte aqui, cole a URL do supervisor e o token, teste e salve.",
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
    "Preencha o .env e suba o Compose.",
    "Cole a URL do supervisor e o token, teste e salve.",
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
    "Edite o .env, suba o Compose, abra só a porta do app (443 ou 5173). O supervisor fica interno, com token.",
    "Cole a URL e o token aqui, teste e salve.",
  ],
};

const GUIDES: Record<string, MachineGuide> = {
  docker: DOCKER_GUIDE,
  "remote-supervisor": REMOTE_GUIDE,
  e2b: E2B_GUIDE,
  box: BOX_GUIDE,
  "vps-hetzner": HETZNER_GUIDE,
  "vps-digitalocean": DIGITALOCEAN_GUIDE,
  "vps-generic": GENERIC_VPS_GUIDE,
};

const FAMILY_GUIDES: Record<OssMachine, MachineGuide> = {
  docker: DOCKER_GUIDE,
  "remote-supervisor": REMOTE_GUIDE,
  e2b: E2B_GUIDE,
  box: BOX_GUIDE,
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
