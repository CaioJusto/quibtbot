# Computador dos bots — Docker, VPS, E2B, Box e Daytona

Pesquisa atualizada em 01/09/2026 contra o código deste repositório e a documentação oficial da E2B, Box e Daytona. O texto de onboarding que a pessoa vê no app vem de `packages/core/src/machine-onboarding.ts`. Este arquivo é a versão longa, inclusive para quem não é técnico.

## O que o Quibt Bot é hoje

Produto **open source / local-first**. Você instala, traz o modelo, escolhe a máquina. A Quibt não revende VPS, E2B, Box nem Daytona. Cloud (`QUIBT_EDITION=cloud`) existe só como flag de operador — não aparece no site, no README nem no onboarding público.

O app (web, Electron, celular) é só a janela. Os comandos do bot rodam no **provedor** que você escolheu, nunca como o seu usuário do macOS ou do Windows.

Duas perguntas, respondidas separadamente: **Onde o Quibt fica ligado?** (o servidor — API,
worker, Postgres — que roda neste computador, na sua VPS ou numa VM da Box; E2B nunca aparece
aqui, porque ela só isola o computador de um bot) e **Onde os bots trabalham?** (é isto que
este arquivo detalha: Docker, VPS/remote-supervisor, E2B, Box ou Daytona). Ver
[`architecture.md`](./architecture.md) (em inglês) para o desenho completo do sistema.

Uma CLI Claude Code, Codex, Grok ou ACP extra escolhida como **modelo** fica do lado do
servidor (host da API/worker). Ela não é instalada nestes computadores de bot, mas chama as
mesmas ferramentas (shell, arquivos, print, `computer`) contra o sandbox já escolhido. Não
controla o Mac/Windows. Esse limite está em [`cli-engines.md`](./cli-engines.md).

## Mandar o que está na tela

Peça “manda print” e o bot tira a foto da tela e põe no fio; peça um vídeo e ele grava até
60 segundos. O print é lido do X pelo `python3-xlib` que já vem na imagem. O vídeo precisa
do **ffmpeg**, que entrou na imagem depois: um computador criado antes disso segue com a
imagem antiga e o bot vai avisar. Para atualizar:

```bash
pnpm sandbox:build   # reconstrói quibt/computer:local
```

Depois recrie o computador do bot. Qualquer arquivo que ele produza no Linux — PDF,
planilha, uma pasta zipada — vai para a conversa pelo mesmo caminho.

## O que pede aprovação

O computador é do bot — um container, uma VPS, um sandbox — nunca a sua máquina. Por isso um
comando comum (`ls`, `xdg-open https://…`, `python3 script.py`) **não pede card**: com
"aprovar automaticamente" ligado (o padrão de todo bot) ele roda e a conversa segue. O que
para sempre, auto-aprovar ou não: apagar em massa (`rm -rf`, `git reset --hard`, `DROP
TABLE`…), mexer em segredo (`.env`, `~/.ssh`, `credentials.json`…), criar ou apagar outro
bot. Nesses cards aparece **Recusar / Permitir** — e **Sempre permitir** só quando o sim
permanente vale para a próxima vez (um card destrutivo vem sem ele). Tarefa que chega por
webhook, sem ninguém olhando, pede aprovação para tudo: [webhooks.md](webhooks.md).

No computador do bot, `xdg-open`, `chromium` e `google-chrome` viram `quibt-open`: a URL
abre como aba no navegador que já está na tela daquele bot, com o perfil dele, e não numa
segunda janela (nem morre no "No usable sandbox" do Chromium puro em container).

## A pergunta das abas e da imagem

**Cada bot abre uma aba?** Não. Em Docker e na VPS cada bot ganha um **desktop gráfico inteiro** (tela virtual X11 + janelas + Chrome próprio). O painel do Quibt mostra essa tela. Não é uma aba do seu Chrome, nem uma aba compartilhada dentro de um único navegador.

**É o mesmo computador, mas a imagem parece um pouco diferente?** No Docker e na VPS, sim: um container Linux por workspace, sempre a imagem `quibt/computer:local`. A parede começa igual (`#111113`). Cada bot tem o próprio display (até 32 sessões), o próprio Chrome e as próprias janelas, então a “foto” da tela muda. A pasta de casa é a mesma; cookies do Chromium podem ser semeados entre sessões (`box-chrome`), então um login feito num bot pode aparecer noutro.

**Preciso assumir o controle para ver a tela?** Para mexer, sim; para olhar, não. A URL assinada chega ao soquete VNC de verdade: o `view_only` do noVNC é só JavaScript no navegador, então a API **não emite** capacidade enquanto este ator não tiver o lease. Sem o teclado ainda dá para **olhar**: o painel e a tela cheia pedem um retrato (`computer.preview`, um PNG com cache de 3 s) a cada 3 s e o mostram com o selo "ao vivo · há Ns", com o botão **Assumir controle** por cima; o poll para com o painel fechado, a aba escondida ou o controle na sua mão. Se o retrato falhar, o último quadro fica até envelhecer, com "sem prévia · tentando de novo" por cima. **Liberar** tira a URL na hora. O controle vale 15 minutos a partir do último uso: cada tecla, clique ou colagem renova o prazo (a tela mostra "controle até HH:mm"). O heartbeat que o app manda enquanto a tela está aberta acorda o container, mas só empurra o prazo com prova de gente: uso desde a última renovação, ou a pessoa estar mesmo na tela (aba à vista, janela em foco e o teclado dentro do quadro; no celular, o app em primeiro plano nessa tela) — o que se digita dentro do noVNC vai direto pelo WebSocket e o servidor não vê. Uma aba deixada aberta atrás de outra não segura o teclado. Quem para de usar por 15 minutos devolve o computador ao bot sozinho. A capacidade sai pela API e o app serve em `/novnc/…`; ela vale para aquele servidor de tela até expirar, porque o cliente noVNC busca os próprios scripts e abre o WebSocket em caminhos diferentes.

**O Crocbot (“Croc Pot”) faz isso?** Não do mesmo jeito. O Crocbot ou sobe um **container Docker por agente/sessão**, ou controla **abas do Chrome** (perfil isolado `croc`, ou extensão no Chrome que você já usa). Ele não coloca vários desktops X11 dentro de um único Linux de workspace. O Quibt no Docker é “um PC do escritório, um monitor por bot”. E2B, Box e Daytona no Quibt são “um computador isolado por bot”, mais perto do sandbox-por-agente do Crocbot do que do modelo de abas.

## Docker (nesta máquina)

**Para quem:** começar em casa, um aparelho, sem conta de nuvem.

**O que a pessoa faz**

1. No Mac, abre o Quibt Bot e deixa o assistente encontrar ou instalar o Docker automaticamente. O macOS pode pedir a senha uma vez.
2. No Windows ou Linux, instala e abre o Docker antes de continuar.
3. No onboarding, deixa “Nesta máquina (Docker)” selecionado, toca em Testar e depois em Salvar.

**O que o sistema faz de verdade**

- O supervisor (`:7091`) cria **um** container por workspace, com cota de CPU/RAM, home persistente e rede própria quando `SANDBOX_SCREEN_NETWORK=internal`.
- O container nasce com `restart: unless-stopped`: depois de reiniciar a máquina ou o Docker ele volta sozinho, e um `docker stop` dado na mão é desfeito pelo próximo comando do bot ou ao abrir a tela. As janelas de antes se perdem; a pasta de casa, não.
- `quibt-session start <botId> <display>` sobe Xvfb, gerenciador de janelas, Chromium (perfil persistente no volume privado `/quibt-desktops/<bot>/chrome`) e noVNC numa porta por display.
- O display de cada bot é o mesmo depois que o container volta: a API manda o que tem escrito (`x-quibt-display`) e o supervisor guarda o de cada bot em `/quibt-desktops/.displays`. Sem isso o segundo bot a acordar pegava o display do primeiro, e como a pasta de cada um é do dono (uid `10000+display`), nenhum dos dois voltava a ter tela.
- A barra embaixo da mesa é o `tint2` (`/etc/quibt/tint2rc`), com três atalhos: **Navegador** (Chromium), **Terminal** (xterm) e **Arquivos** (pcmanfm, abrindo `/home/quibt`). Cada um vem de um `.desktop` em `/usr/share/applications`; mexer neles pede `pnpm sandbox:build` para a imagem voltar a bater.
- `DISPLAY` é da sessão, nunca do pedido do bot — um bot não dirige a tela do colega.
- Idle: `SANDBOX_IDLE_MS` (padrão 10 min) pausa o computador.
- Comando: `SANDBOX_COMMAND_TIMEOUT_MS` (padrão 5 min) mata um `shell` que não termina.

**Limite honesto:** o notebook precisa estar ligado. Várias pessoas no mesmo Docker compartilham o kernel do host — por isso o Cloud recusa Docker, e o self-host público deve ir para E2B, Box, Daytona ou VPS dedicada. O celular no mesmo Wi-Fi lê o QR em **Ajustes → Celular → Nesta rede**. Fora dessa rede, **Qualquer rede** usa um `https://` que **você** sobe (Cloudflare Tunnel ou Tailscale Funnel apontando para `http://127.0.0.1:5173`). O Quibt não hospeda túnel; o PC continua precisando ficar ligado.

## VPS / máquina virtual (remote-supervisor)

**Para quem:** quer o mesmo Linux do Docker, mas num servidor que não desliga com o notebook.

**O caminho que funciona inteiro: instale o stack todo na VPS.** É o que a receita do catálogo
faz. API, worker, banco, supervisor e tela ficam no mesmo host, a tela continua na rede interna
do Docker e o celular fala com a VPS quando o laptop está desligado. Nada para colar.

**O que a pessoa faz**

1. Cria uma VM Ubuntu 22.04/24.04 na **conta dela** (Hetzner CX22, Droplet 2 GB+, ou qualquer VPS). A Quibt não provisiona e não cobra.
2. Escolhe a receita no catálogo (Hetzner, DigitalOcean, script genérico) e roda o script.
3. Preenche o `.env` do servidor com `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SANDBOX_SUPERVISOR_TOKEN` e `BOOTSTRAP_SECRET` (cada um com `openssl rand -hex 32`), mais `RESEND_API_KEY` ou `AUTH_EMAIL_DISABLED=true`, e sobe o Compose. O Compose roda como produção: valor faltando, com menos de 32 caracteres ou ainda começando com `replace-with-` faz o serviço recusar subir.
4. Entra no Quibt dessa VPS por senha ou por código de pareamento. A entrada automática sem senha existe só no computador onde o Quibt roda: numa instalação de rede ou pública, `POST /api/local/session` responde 404 para todo mundo.

**Só o computador noutra máquina (`remote-supervisor`)** — existe, e tem uma condição e um limite:

- A porta `7091` **não é publicada** por padrão, e não deve ser: quem fala com ela manda no
  Docker daquele host. Para abri-la, o operador carrega um arquivo a mais e liga o profile, no
  host do computador:

  ```bash
  QUIBT_SUPERVISOR_PUBLIC_HOST=<nome público> \
    docker compose -f infra/compose/docker-compose.desktop.yml \
    -f infra/compose/docker-compose.supervisor-tls.yml \
    --profile supervisor-tls up -d supervisor supervisor-tls
  ```

  O arquivo é separado de propósito: o Compose interpola tudo o que carrega, então uma variável
  obrigatória no compose principal quebraria o `up` de quem nunca pediu TLS. Quem encara a
  internet é o Caddy, com certificado Let's Encrypt; o supervisor continua exigindo o
  `SANDBOX_SUPERVISOR_TOKEN` em toda rota `/computers`. Esse serviço usa 80/443 — não o ligue
  na mesma máquina que serve o site pelo profile `public`.
- No Quibt, cole o endereço **https** desse nome e o **mesmo** token. "Testar máquina" agora
  bate numa rota que exige o token: token errado reprova ali, e não no primeiro boot. Endereço
  `http` fora de `127.0.0.1`, endereço de rede interna e `169.254.169.254` são recusados.
- **A tela não atravessa um supervisor remoto.** O noVNC fica na rede interna do Docker daquele
  host, e o proxy `/novnc` do app só alcança a tela quando o app roda no mesmo host (ou na mesma
  rede privada, com `SANDBOX_SCREEN_HOST`/`SANDBOX_SCREEN_BIND_HOST` definidos lá — ver
  [docs/self-host.md](./self-host.md)). Com a API no notebook e o supervisor na VPS, os comandos,
  os arquivos e as rotinas funcionam; o painel da tela fica preto. Se você quer ver a tela,
  instale o stack inteiro na VPS.

**O que o sistema faz de verdade**

- É o `DockerSandboxProvider` apontando para outro host. Mesma imagem, mesmas sessões por bot.
- Receitas (`vps-hetzner`, …) **ativam como** `remote-supervisor` depois que o host responde.
- O celular, com a mesma conta, continua falando com a API da VPS quando o laptop está off.

Documentação dos provedores (não da Quibt): [criar servidor Hetzner](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server), [criar Droplet](https://docs.digitalocean.com/products/droplets/how-to/create/).

## E2B

Conferido em [e2b.dev/docs](https://e2b.dev/docs) e no SDK `@e2b/desktop` (15/08/2026).

**Para quem:** não quer Docker, ou precisa isolar um bot do outro na nuvem.

**O que a pessoa faz**

1. Cria conta em [e2b.dev/auth/sign-up](https://e2b.dev/auth/sign-up). Contas novas recebem crédito de boas-vindas (a E2B anuncia US$ 100 no quickstart).
2. Copia a chave em [Dashboard → Keys](https://e2b.dev/dashboard?tab=keys).
3. Cola no onboarding ou em Ajustes → Máquina. Testa. Salva.

Não precisa instalar o SDK. O Quibt já fala com a E2B.

**O que o sistema faz de verdade** (`packages/adapters/src/e2b-sandbox.ts`)

- `Sandbox.create` com template Desktop, resolução 1280×800, `lifecycle.onTimeout: pause`.
- Um `providerRef` (sandbox id) **por bot**. `connect` retoma; se o sandbox morreu, cria outro.
- Abre Chrome/Firefox/Chromium no desktop; o painel usa o stream VNC autenticado.
- A E2B documenta **um stream por sandbox** — parar o stream atual antes de outro.
- Home da imagem E2B é `/home/user` (o Docker usa `/home/quibt`; o adapter remapeia).
- Arquivos do workspace **não** são compartilhados entre bots. Multi-display é só o caminho Docker.

**Limite honesto:** você paga a E2B. Hobby ~1 h de sandbox ligado; Pro até 24 h. Isolamento é microVM (Firecracker), não o container Docker local.

## Box (box.ascii.dev)

Conferido em [docs.ascii.dev/box](https://docs.ascii.dev/box/quickstart) e na API v1 (15/08/2026).

**Para quem:** quer uma Ubuntu que lembra o disco depois de pausar, sem administrar VPS.

**O que a pessoa faz**

1. Instala o CLI (`curl -fsSL https://box.ascii.dev/install | sh`) ou só entra no [dashboard](https://box.ascii.dev/).
2. Login com GitHub, diz se as Boxes são para você ou para terceiros (o padrão “plataforma” marca o ambiente _safe for third parties_).
3. Cria `BOX_API_KEY` no dashboard ou com `box api-key create`.
4. Cola no Quibt. Testa. Salva.

**O que o sistema faz de verdade** (`packages/adapters/src/box-sandbox.ts`)

- `POST /boxes` com `ttlSeconds: null` (sem auto-stop da Box) e `noEnv: true` (credenciais do operador Quibt **não** entram na VM).
- É uma VM por bot: um box id **por bot**, nunca compartilhado. `stop` arquiva o disco; `resume` restaura. O idle do Quibt (`SANDBOX_IDLE_MS`) é quem para.
- Desktop: `POST /boxes/{id}/desktop?vnc=1` (URL noVNC com segredo). Assumir controle é nessa tela; a API v1 não tem endpoint de teclado/mouse separado.
- A Box documenta VM Ubuntu completa, desktop ~60 fps, cobrança por segundo, trial de 7 dias no onboarding deles.

**Limite honesto:** você paga a Box. Não é a imagem `quibt/computer:local`. Não há delete na API v1 que o adapter usa — `destroy` arquiva.

## Daytona

Conferido na [documentação oficial](https://www.daytona.io/docs/en/typescript-sdk/) e no SDK `@daytona/sdk` 0.207.0 (01/09/2026).

**Para quem:** quer um sandbox isolado por bot com terminal, filesystem, desktop VNC e Computer Use na nuvem.

**O que a pessoa faz**

1. Entra em [app.daytona.io](https://app.daytona.io/) e cria uma chave no dashboard.
2. Cola `DAYTONA_API_KEY` no onboarding ou em Ajustes → Máquina. Testa. Salva.
3. Em Daytona self-hosted, define também `DAYTONA_API_URL`; `DAYTONA_TARGET` escolhe um target/região quando a conta usa mais de um. Na Daytona hospedada, ambos são opcionais.

**O que o sistema faz de verdade** (`packages/adapters/src/daytona-sandbox.ts`)

- Usa o SDK atual `@daytona/sdk` e a imagem padrão, porque ela inclui Xvfb, Xfce, x11vnc e noVNC exigidos por `computerUse`.
- Cria um sandbox privado por bot, resolução 1280×800, sem auto-delete. O idle do Quibt chama `stop`; a próxima mensagem chama `start` no mesmo id e preserva o filesystem. Excluir o bot chama `Daytona.delete`.
- Comandos usam sessões do SDK, com cwd, ambiente, timeout e stdout/stderr separados.
- O painel inicia `computerUse`, expõe a porta noVNC 6080 por uma URL assinada de uma hora e revoga o token quando a tela fecha. Teclado, mouse e screenshots usam a API Computer Use.
- A SDK atual não oferece clipboard: “colar” digita o texto pelo Computer Use. PTY interativo existe na SDK, mas o contrato atual do executor continua orientado a comandos.

**Limite honesto:** você paga a Daytona. A URL de tela expira; o painel pede outra quando necessário. Imagens customizadas só terão desktop se incluírem os pacotes VNC documentados, por isso o provider usa a imagem padrão.

## O que funciona de ponta a ponta

| Peça                                 | Docker / VPS                                                                | E2B                              | Box                                | Daytona                              |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- | ------------------------------------ |
| Ligar o desktop na primeira mensagem | Sim (`quibt-session`)                                                       | Sim (`Sandbox.create` + browser) | Sim (espera `ready`, pede desktop) | Sim (`create` + `computerUse.start`) |
| Painel noVNC / stream no app         | Sim, URL assinada `/novnc/*`                                                | Sim, stream E2B                  | Sim, URL da Box                    | Sim, preview assinado da porta 6080  |
| Assumir controle                     | noVNC + input xdotool                                                       | stream + `press` / mouse         | só noVNC interativo                | noVNC + Computer Use                 |
| Vários bots ao mesmo tempo           | Sim, displays 1…32 no **mesmo** container                                   | Sim, **N sandboxes**             | Sim, **N VMs**                     | Sim, **N sandboxes**                 |
| Persistência                         | Home no disco do host + checkpoint portátil por bot                         | Pause/resume **e** checkpoint em `DATA_DIR` | Archive/resume **e** checkpoint em `DATA_DIR` | Stop/start **e** checkpoint em `DATA_DIR` |
| Trocar de máquina depois             | Salva em `deployment_settings`; no próximo boot o home e o perfil Chromium voltam do checkpoint | idem                             | idem                               | idem                                 |

O roteador (`createRoutingSandboxProvider`) nunca teleporta um desktop ligado para outro provedor. Computador já criado fica na família que o criou até o próximo boot; aí o disco do vendor é só cache. Arquivos e cookies do Chromium daquele bot voltam de um snapshot em `DATA_DIR` — ver [workspace-checkpoint.md](./workspace-checkpoint.md). Janelas abertas, o X11 e o noVNC **não** atravessam a troca.

**Limite honesto da troca:** o que sobrevive é a pasta de casa (nos provedores isolados) e o perfil do navegador (logins gravados no Chromium). No Docker a casa `/home/quibt` continua compartilhada entre os bots do workspace: o checkpoint leva uma cópia ao sair, mas ao voltar só o Chrome daquele bot é restaurado, para não apagar o colega. A mesa gráfica não teleporta: ao ligar noutro provedor a tela nasce vazia, com os arquivos e os cookies já no lugar.

## Onde o texto do app vive

- Cartões curtos: `OSS_MACHINE_COPY` em `packages/core/src/edition.ts`
- Quadro “o que você precisa fazer”: `packages/core/src/machine-onboarding.ts`
- Catálogo e receitas: `packages/core/src/computer-catalog.ts`
- Telas: onboarding web/mobile, Ajustes → Máquina, prompt do desktop
