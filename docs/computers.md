# Computador dos bots — Docker, VPS, E2B e Box

Pesquisa de 15/08/2026 contra o código deste repositório e a documentação oficial da E2B e da Box. O texto de onboarding que a pessoa vê no app vem de `packages/core/src/machine-onboarding.ts`. Este arquivo é a versão longa, inclusive para quem não é técnico.

## O que o Quibt Bot é hoje

Produto **open source / local-first**. Você instala, traz o modelo, escolhe a máquina. A Quibt não revende VPS, E2B nem Box. Cloud (`QUIBT_EDITION=cloud`) existe só como flag de operador — não aparece no site, no README nem no onboarding público.

O app (web, Electron, celular) é só a janela. Os comandos do bot rodam no **provedor** que você escolheu, nunca como o seu usuário do macOS ou do Windows.

Duas perguntas, respondidas separadamente: **Onde o Quibt fica ligado?** (o servidor — API,
worker, Postgres — que roda neste computador, na sua VPS ou numa VM da Box; E2B nunca aparece
aqui, porque ela só isola o computador de um bot) e **Onde os bots trabalham?** (é isto que
este arquivo detalha: Docker, VPS/remote-supervisor, E2B ou Box). Ver
[`architecture.md`](./architecture.md) (em inglês) para o desenho completo do sistema.

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

**Preciso assumir o controle para ver a tela?** Sim. A URL assinada chega ao soquete VNC de verdade: o `view_only` do noVNC é só JavaScript no navegador, então a API **não emite** capacidade enquanto este ator não tiver o lease. Sem o teclado, o painel mostra o placeholder e pede **Assumir controle**. **Liberar** tira a URL na hora. A capacidade sai pela API e o app serve em `/novnc/…`; ela vale para aquele servidor de tela até expirar, porque o cliente noVNC busca os próprios scripts e abre o WebSocket em caminhos diferentes.

**O Crocbot (“Croc Pot”) faz isso?** Não do mesmo jeito. O Crocbot ou sobe um **container Docker por agente/sessão**, ou controla **abas do Chrome** (perfil isolado `croc`, ou extensão no Chrome que você já usa). Ele não coloca vários desktops X11 dentro de um único Linux de workspace. O Quibt no Docker é “um PC do escritório, um monitor por bot”. E2B e Box no Quibt são “um computador isolado por bot”, mais perto do sandbox-por-agente do Crocbot do que do modelo de abas.

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

**Limite honesto:** o notebook precisa estar ligado. Várias pessoas no mesmo Docker compartilham o kernel do host — por isso o Cloud recusa Docker, e o self-host público deve ir para E2B, Box ou VPS dedicada. O celular no mesmo Wi-Fi lê o QR em **Ajustes → Celular → Nesta rede**. Fora dessa rede, **Qualquer rede** usa um `https://` que **você** sobe (Cloudflare Tunnel ou Tailscale Funnel apontando para `http://127.0.0.1:5173`). O Quibt não hospeda túnel; o PC continua precisando ficar ligado.

## VPS / máquina virtual (remote-supervisor)

**Para quem:** quer o mesmo Linux do Docker, mas num servidor que não desliga com o notebook.

**O que a pessoa faz**

1. Cria uma VM Ubuntu 22.04/24.04 na **conta dela** (Hetzner CX22, Droplet 2 GB+, ou qualquer VPS). A Quibt não provisiona e não cobra.
2. Escolhe a receita no catálogo (Hetzner, DigitalOcean, script genérico) e roda o script.
3. Preenche `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` e `SANDBOX_SUPERVISOR_TOKEN` no `.env` do servidor e sobe o Compose.
4. Cola no Quibt a URL (`https://sua-vps:7091`) e o **mesmo** token. Testa. Salva.

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

## O que funciona de ponta a ponta

| Peça                                 | Docker / VPS                                                                | E2B                              | Box                                |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| Ligar o desktop na primeira mensagem | Sim (`quibt-session`)                                                       | Sim (`Sandbox.create` + browser) | Sim (espera `ready`, pede desktop) |
| Painel noVNC / stream no app         | Sim, URL assinada `/novnc/*`                                                | Sim, stream E2B                  | Sim, URL da Box                    |
| Assumir controle                     | noVNC + input xdotool                                                       | stream + `press` / mouse         | só noVNC interativo                |
| Vários bots ao mesmo tempo           | Sim, displays 1…32 no **mesmo** container                                   | Sim, **N sandboxes**             | Sim, **N VMs**                     |
| Persistência                         | Home no disco do host                                                       | Pause/resume do sandbox E2B      | Archive/resume do disco Box        |
| Trocar de máquina depois             | Salva em `deployment_settings`; vale no **próximo** boot; o antigo é parado | idem                             | idem                               |

O roteador (`createRoutingSandboxProvider`) nunca teleporta um desktop ligado para outro provedor. Computador já criado fica na família que o criou.

## Onde o texto do app vive

- Cartões curtos: `OSS_MACHINE_COPY` em `packages/core/src/edition.ts`
- Quadro “o que você precisa fazer”: `packages/core/src/machine-onboarding.ts`
- Catálogo e receitas: `packages/core/src/computer-catalog.ts`
- Telas: onboarding web/mobile, Ajustes → Máquina, prompt do desktop
