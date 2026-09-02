# Setup prompt / Prompt de instalação

Cole o bloco abaixo em um assistente de IA (Claude, ChatGPT…) para ele te guiar na
instalação do Quibt Bot, comando por comando. A versão em inglês vem depois.
/ Paste the block below into an AI assistant (Claude, ChatGPT…) and it will walk you
through installing Quibt Bot, command by command. The English version follows.

## Português

```text
Você vai me guiar na instalação do Quibt Bot (https://github.com/CaioJusto/quibtbot),
um produto open source e local-first: eu rodo o stack, eu trago o modelo, eu escolho
onde o computador dos bots roda. Não existe nuvem hospedada nem plano de tokens da
Quibt. Use apenas os comandos abaixo — eles vêm de scripts/install.sh e de
docs/self-host.md do repositório — e me pergunte qual caminho eu quero antes de começar.

Caminho A — um comando (Mac Apple silicon ou Linux, sem o app):

  curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/f75c7c22b79a75cf682e3e461e6d61ea58202101/scripts/install.sh \
    | QUIBT_RELEASE=0.2.20 sh

  O script baixa o binário `quibtbot` da release para a minha arquitetura, confere o
  SHA-256 contra o manifesto autenticado pelo metadata da release no GitHub, instala em
  /usr/local/bin (ou ~/.local/bin) e roda `quibtbot install`: detecta (ou instala, no
  Linux) o Docker, gera os segredos, sobe os serviços e imprime a URL e o código para o
  celular. Variáveis opcionais: QUIBT_RELEASE, QUIBT_BIN_DIR, QUIBT_NO_RUN=1 (só baixar),
  QUIBT_SHOW_SENSITIVE=1 (mostrar o código/QR em fluxo remoto). Em Mac Intel esse binário
  não existe; nesse caso me leve ao caminho C. Para desfazer tudo: `quibtbot uninstall`
  (ou `quibtbot uninstall --keep-data` para guardar Postgres e os homes dos bots).

Caminho B — Docker Compose numa máquina só (VPS ou PC que fica ligado):

  1. cp .env.example .env e trocar cada placeholder publicado. Gerar cada segredo com
     `openssl rand -hex 32`:
       BETTER_AUTH_SECRET=…        # cookies de sessão
       ENCRYPTION_KEY=…            # chaves de modelo/plugin guardadas no banco
       SANDBOX_SUPERVISOR_TOKEN=…  # credencial própria, diferente de BETTER_AUTH_SECRET
       BOOTSTRAP_SECRET=…          # convites de primeiro dono, só loopback
     Escolher o mailer: RESEND_API_KEY, ou AUTH_EMAIL_DISABLED=true (só com
     BILLING_ENABLED=false). Manter BILLING_ENABLED=false.
  2. Definir OPENROUTER_API_KEY (ou colar a chave depois, na interface).
  3. pnpm sandbox:build
  4. docker compose -f infra/compose/docker-compose.yml up --build
  5. pnpm owner:code — abrir a origem web (http://127.0.0.1:5173 por padrão) e digitar o
     código de uso único. Só essa primeira conta vira dona do deploy.
  Postgres e API ficam só em loopback (127.0.0.1:5433 e 127.0.0.1:3100); clientes usam a
  origem web :5173. Não expor banco nem API numa VPS pública. Não commitar o .env.

Caminho C — a partir do código-fonte (desenvolvimento; Mac Intel entra aqui):

  Pré-requisitos: Node.js >= 22.19, pnpm 10.34.5, Docker Desktop ou Engine.
  cp .env.example .env       # BETTER_AUTH_SECRET, ENCRYPTION_KEY; OPENROUTER_API_KEY opcional
  docker compose -f infra/compose/docker-compose.yml up postgres -d
  pnpm install
  pnpm db:generate
  pnpm db:migrate
  pnpm sandbox:build
  pnpm dev
  Abrir http://127.0.0.1:5173. Para navegador puro: pnpm owner:code e digitar o código.
  (BOOTSTRAP_SECRET vazio neste caminho é derivado de BETTER_AUTH_SECRET, igual à API.)
  `pnpm desktop` embrulha a mesma UI no Electron.

Regras: nunca coloque chaves (OpenRouter, Composio, tokens) em git, logs ou chat; nunca
sugira expor a porta do supervisor (7091) nem o Postgres; upgrades de schema são só
`pnpm db:migrate` (prisma migrate deploy), nunca `db push` ou `migrate dev`. Se algo
falhar, me mostre o erro e o próximo comando, um passo de cada vez.
```

## English

```text
You will walk me through installing Quibt Bot (https://github.com/CaioJusto/quibtbot),
an open-source, local-first product: I run the stack, I bring the model, I pick where
the bots' computer runs. There is no hosted cloud and no Quibt token plan. Use only the
commands below — they come from the repository's scripts/install.sh and
docs/self-host.md — and ask me which path I want before starting.

Path A — one command (Apple-silicon Mac or Linux, no desktop app):

  curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/f75c7c22b79a75cf682e3e461e6d61ea58202101/scripts/install.sh \
    | QUIBT_RELEASE=0.2.20 sh

  The script downloads the `quibtbot` release binary for my architecture, checks its
  SHA-256 against the manifest authenticated by GitHub's release metadata, installs it
  into /usr/local/bin (or ~/.local/bin) and runs `quibtbot install`: it detects (or, on
  Linux, installs) Docker, generates secrets, brings the services up, and prints the URL
  plus the pairing code for the phone. Optional variables: QUIBT_RELEASE, QUIBT_BIN_DIR,
  QUIBT_NO_RUN=1 (download only), QUIBT_SHOW_SENSITIVE=1 (show the code/QR in remote
  flows). There is no Intel-Mac binary; in that case take me to path C. To undo
  everything: `quibtbot uninstall` (or `quibtbot uninstall --keep-data` to keep Postgres
  and the bots' homes).

Path B — Docker Compose on a single machine (a VPS or an always-on PC):

  1. cp .env.example .env and replace every published placeholder. Generate each secret
     with `openssl rand -hex 32`:
       BETTER_AUTH_SECRET=…        # session cookies
       ENCRYPTION_KEY=…            # model/plugin keys stored in the database
       SANDBOX_SUPERVISOR_TOKEN=…  # its own credential, different from BETTER_AUTH_SECRET
       BOOTSTRAP_SECRET=…          # loopback-only first-owner invites
     Pick the mailer: RESEND_API_KEY, or AUTH_EMAIL_DISABLED=true (only with
     BILLING_ENABLED=false). Keep BILLING_ENABLED=false.
  2. Set OPENROUTER_API_KEY (or paste the key later in the UI).
  3. pnpm sandbox:build
  4. docker compose -f infra/compose/docker-compose.yml up --build
  5. pnpm owner:code — open the web origin (http://127.0.0.1:5173 by default) and enter
     the one-use code. Only that first account becomes the deployment owner.
  Postgres and the API stay loopback-only (127.0.0.1:5433 and 127.0.0.1:3100); clients
  use the web origin on :5173. Never expose the database or API on a public VPS. Never
  commit .env.

Path C — from source (development; Intel Macs go here):

  Prerequisites: Node.js >= 22.19, pnpm 10.34.5, Docker Desktop or Engine.
  cp .env.example .env       # BETTER_AUTH_SECRET, ENCRYPTION_KEY; optional OPENROUTER_API_KEY
  docker compose -f infra/compose/docker-compose.yml up postgres -d
  pnpm install
  pnpm db:generate
  pnpm db:migrate
  pnpm sandbox:build
  pnpm dev
  Open http://127.0.0.1:5173. For a plain browser: pnpm owner:code and enter the code.
  (An empty BOOTSTRAP_SECRET on this path is derived from BETTER_AUTH_SECRET, same as the API.)
  `pnpm desktop` wraps the same UI in Electron.

Rules: never put keys (OpenRouter, Composio, tokens) in git, logs, or chat; never
suggest exposing the supervisor port (7091) or Postgres; schema upgrades are only
`pnpm db:migrate` (prisma migrate deploy), never `db push` or `migrate dev`. If a step
fails, show me the error and the next command, one step at a time.
```

Sources / Fontes: [`scripts/install.sh`](scripts/install.sh),
[`docs/self-host.md`](docs/self-host.md), [`README.md`](README.md).
