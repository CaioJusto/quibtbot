# Instalação unificada e clientes completos — desenho

## Objetivo

Entregar um caminho público integralmente open source no qual uma pessoa consiga:

1. instalar o servidor Quibt em seu computador, em uma VPS ou em uma VM Box;
2. vincular desktop e celular por QR Code ou código temporário;
3. configurar o modelo e o computador dos bots;
4. usar os recursos essenciais do produto tanto no desktop quanto no mobile;
5. manter tudo sob sua própria conta, máquina e chaves, sem infraestrutura operacional hospedada ou revendida pela Quibt.

O comando público e canônico é `quibtbot install`.

## Princípios obrigatórios

- O servidor Quibt e o computador do bot são decisões diferentes.
- O servidor Quibt pode rodar localmente, em VPS ou em uma VM Box persistente.
- E2B não hospeda o servidor Quibt; é somente um computador isolado por bot.
- Docker e remote-supervisor compartilham uma máquina por workspace, com uma sessão gráfica por bot.
- E2B e Box, quando escolhidos como computador do bot, usam uma sandbox ou VM separada por bot.
- O caminho público não oferece Cloud, plano Quibt, waitlist ou infraestrutura gerenciada pela Quibt.
- Binários e imagens publicados no GitHub Releases/GHCR são artefatos de distribuição, não infraestrutura operacional.
- Toda credencial pertence ao usuário. Credenciais SSH ficam somente no dispositivo que executa a instalação remota.
- Toda interface destinada a pessoas não técnicas deve explicar pré-requisitos, ações, custos e consequências.

## Modelo mental apresentado ao usuário

O assistente fará duas perguntas em linguagem simples.

### 1. Onde o Quibt fica ligado?

- **Neste computador:** mais simples; celular e bots dependem de o computador permanecer ligado.
- **VPS:** funcionamento contínuo em um servidor contratado pelo usuário.
- **Box:** funcionamento contínuo em uma VM persistente da conta Box do usuário.

### 2. Onde os bots trabalham?

- **Na mesma máquina:** Docker, padrão recomendado.
- **Em outro servidor:** remote-supervisor em VPS.
- **E2B:** uma sandbox separada por bot.
- **Box:** uma VM separada por bot.

A interface nunca afirmará que escolher E2B ou Box para um bot mantém o celular funcionando quando a API ainda está no notebook.

## Arquitetura geral

### Artefatos de distribuição

Cada release publicará:

- executáveis `quibtbot` para Linux, macOS e Windows;
- uma imagem versionada da stack contendo API, worker e web;
- uma imagem versionada do supervisor;
- uma imagem versionada do computador Docker;
- instaladores Electron para Linux, macOS e Windows;
- checksums para todos os binários e instaladores;
- um manifesto Compose somente com `image:`, sem contextos de build.

As imagens serão fixadas na mesma versão da CLI. Nenhuma instalação dependerá do checkout do monorepo.

### CLI `quibtbot`

O executável será a única camada de orquestração da instalação. Comandos iniciais:

- `quibtbot install`: instala ou retoma uma instalação;
- `quibtbot status`: mostra serviços, versão e URL;
- `quibtbot doctor`: executa diagnósticos sem alterar dados;
- `quibtbot pair`: emite novo QR/código permitido pelo estado do deploy;
- `quibtbot update`: atualiza imagens com backup e verificação.

O bootstrap por `curl`/PowerShell apenas baixa o executável correto, valida checksum e o instala no `PATH`.

### Manifesto da stack

`docker-compose.desktop.yml` será compartilhado por computador, VPS e Box. Ele terá:

- PostgreSQL oficial com volume persistente;
- API, worker e web na imagem versionada da stack;
- supervisor e computador em imagens versionadas;
- um único arquivo de ambiente gerado pela CLI;
- caminhos de dados absolutos, fora do bundle Electron;
- health checks e políticas de reinício;
- portas expostas de acordo com o modo local ou remoto.

O compose de desenvolvimento atual continuará existindo para contribuições a partir do código-fonte.

### Idempotência

`quibtbot install` detectará e preservará:

- segredos já gerados;
- volumes e banco existentes;
- versão já instalada;
- serviços saudáveis;
- etapas concluídas.

Uma nova execução retomará a primeira etapa incompleta. A CLI não removerá volumes nem regenerará segredos sem confirmação destrutiva explícita.

## Fluxo de instalação

### Computador e Electron

1. O Electron detecta Docker Desktop.
2. Se a stack local não responder, oferece “Instalar neste computador” ou “Conectar a outro servidor”.
3. A instalação local invoca a mesma biblioteca/orquestração da CLI.
4. A CLI baixa imagens, cria segredos, sobe serviços, executa migrações e valida `/ready`.
5. O Electron carrega a URL local.
6. A tela de conexão com celular exibe QR e código temporário.

O instalador não levará apenas um YAML inutilizável e não dependerá de `pnpm`, Node ou monorepo no computador do usuário.

### VPS — fluxo guiado

1. O app mostra provedores, custo aproximado, tamanho mínimo e onde clicar.
2. O usuário abre o console web da VPS.
3. Copia o comando de bootstrap e executa `quibtbot install`.
4. A CLI mostra progresso, URL, QR e código.
5. O usuário informa URL + código no celular ou escaneia o QR.

### VPS — instalação SSH avançada

1. O mobile ou desktop coleta host, porta, usuário e autenticação por senha ou chave privada com passphrase.
2. Antes de transmitir credenciais, mostra a impressão digital da chave do host e exige comparação/confirmação.
3. O instalador remoto baixa e valida `quibtbot`, executa `quibtbot install --non-interactive` e transmite apenas eventos de progresso sanitizados.
4. A credencial pode ser salva localmente conforme a decisão do usuário.
5. Ao final, o cliente valida a URL e inicia o vínculo.

A implementação SSH terá uma interface comum e transports específicos:

- desktop: biblioteca SSH com `hostVerifier`;
- mobile: módulo nativo com verificação obrigatória de fingerprint;
- nenhum transport permitirá conexão com verificação de host desabilitada.

### Box como servidor

1. O usuário informa sua API key Box.
2. O app cria ou seleciona uma VM persistente com Docker, Compose, disco e HTTPS.
3. O transport Box executa o mesmo bootstrap e `quibtbot install`.
4. A chave Box fica no armazenamento seguro do cliente e nunca é enviada à API Quibt.
5. A VM criada para o servidor é distinta das VMs Box criadas posteriormente para bots.

## Vínculo inicial e criação do proprietário

Após a stack ficar saudável, a CLI pede à API local um convite de bootstrap e mostra:

- URL normalizada do servidor;
- QR Code com URL e token opaco;
- código Base32 curto para digitação manual;
- expiração visível.

Regras:

- validade de dez minutos;
- uso único;
- armazenamento apenas do hash;
- no mínimo 40 bits de entropia no código;
- rate limit por IP e por deploy;
- segredo interno de bootstrap nunca aparece no QR ou no celular;
- logs não registram código, token ou credenciais;
- enquanto não houver proprietário, cadastro público sem convite é bloqueado;
- o convite autoriza somente a criação do primeiro proprietário;
- depois da criação, o bootstrap inicial é marcado como reivindicado.

O fluxo mobile é:

1. escanear QR ou informar URL + código;
2. validar o deploy e trocar o código por uma sessão de inscrição limitada;
3. criar o primeiro proprietário;
4. armazenar a sessão normal no SecureStore;
5. continuar para modelo, computador dos bots e primeiro bot.

Depois de reivindicado, novos celulares usam o pareamento autenticado já existente. `quibtbot pair` não pode contornar a aprovação de um proprietário existente.

## Armazenamento seguro no mobile

Credenciais SSH, passphrases e API keys de bootstrap:

- usam `expo-secure-store`;
- exigem autenticação do aparelho para leitura;
- são separadas por host e conta;
- nunca passam por Redux, parâmetros de rota, logs ou analytics;
- têm ação explícita “Esquecer credencial”;
- são invalidadas de forma segura quando biometria/chaves do sistema mudam;
- não são incluídas em backup restaurável entre aparelhos.

Tokens normais da sessão continuam separados das credenciais de infraestrutura.

## Onboarding e configurações

### Ordem OSS

1. modelo;
2. onde o Quibt fica ligado, quando ainda não estiver definido;
3. onde os bots trabalham;
4. primeiro bot.

### Modelo

Web e mobile permitirão, no onboarding e posteriormente:

- chave OpenRouter;
- URL Ollama/LM Studio;
- login por assinatura suportada;
- pular com explicação de que o bot ainda não responderá.

### Computador dos bots

Web e mobile compartilharão:

- catálogo completo;
- receitas VPS;
- guia não técnico;
- campos de credenciais;
- `computers.probe` obrigatório antes de ativar;
- tela pós-onboarding para consultar e trocar provedor.

A troca persiste em `deployment_settings` e não pedirá alteração manual de `SANDBOX_PROVIDER` quando a API puder aplicar a escolha dinamicamente.

## Paridade funcional mobile

“Completo” significa paridade operacional com os recursos essenciais do cliente web, respeitando diferenças da plataforma. Além do onboarding, o mobile terá:

- configuração e troca de modelo e máquina;
- anexos de imagem e arquivo em conversas;
- responder, citar, reagir e editar mensagens;
- alternar ramificações de conversa;
- memória do bot;
- duplicar e exportar bot;
- slash commands e menções;
- gravação e envio de voz quando o servidor tiver transcrição configurada;
- estados claros para push, computador remoto, aprovações e reconexão.

Atalhos de teclado e controles de janela Electron não fazem parte da paridade mobile.

Lógica pura compartilhável será movida para `@quibt/core` ou pacote comum, evitando arquivos web/mobile mantidos “em paralelo”.

## Semântica dos computadores

### Workspace-scoped

Somente `docker` e `remote-supervisor` são compartilhados por workspace.

- `Computer.providerRef` é a referência canônica da máquina.
- Cada `DesktopSession` identifica bot e display.
- Parar uma sessão não remove a máquina enquanto houver sessões irmãs vivas.

### Per-bot

`e2b` e `box` são isolados por bot.

- `DesktopSession.providerRef` é a referência canônica.
- `Computer.providerRef` fica nulo.
- stop/destroy afeta somente a sandbox/VM daquele bot.

Todos os caminhos de boot, idle e destroy usarão os mesmos helpers de persistência e isolamento.

### Compatibilidade Box

Uma migração idempotente:

1. promove referências Box antigas de `Computer` para sessões que não possuam referência;
2. limpa `Computer.providerRef` para Box/E2B;
3. preserva IDs existentes;
4. não destrói VMs;
5. registra situações ambíguas para reparo, sem inventar ou duplicar recursos automaticamente.

## Site público e documentação

O site público:

- terá CTA principal de download/instalação OSS;
- exibirá Linux, macOS, Windows e `quibtbot install`;
- explicará “seu modelo, sua máquina, seus dados”;
- removerá waitlist e oferta Cloud do caminho público;
- manterá páginas operacionais privadas apenas se não forem ligadas ou indexadas.

Documentos obrigatórios:

- `README.md`;
- `docs/architecture.md`;
- `docs/mobile.md`;
- `docs/self-host.md`;
- `docs/desktop.md`;
- `docs/computers.md`;
- `docs/onboarding.md`;
- `packages/core/src/machine-onboarding.ts`.

Todos usarão o mesmo modelo de duas escolhas: servidor Quibt e computador dos bots.

## CI e release

### Pull requests

CI deverá executar explicitamente:

- lint;
- typecheck;
- build de API, worker, web, mobile, desktop e site;
- testes rápidos;
- jornadas com PostgreSQL;
- E2E web;
- testes do instalador e manifesto;
- empacotamento Electron em modo de diretório;
- smoke Docker quando o ambiente permitir.

### Releases

Uma tag versionada:

1. constrói e publica imagens;
2. constrói executáveis `quibtbot` em matriz de sistemas;
3. constrói instaladores Electron;
4. gera checksums;
5. executa smoke da versão publicada;
6. publica GitHub Release.

Assinatura Apple, notarização e Authenticode serão habilitadas quando os segredos do proprietário do projeto estiverem disponíveis. A ausência desses certificados não será disfarçada como validação concluída.

## Estratégia de testes

Toda mudança de comportamento seguirá TDD.

### Unitários

- parser e estado idempotente da CLI;
- resolução de versões e manifesto;
- sanitização de logs;
- fingerprint SSH obrigatório;
- armazenamento/remoção de credenciais;
- código de bootstrap, expiração, uso único e rate limit;
- ordem de onboarding e ações de modelo/máquina;
- Box per-bot e helpers de referência.

### Integração

- instalação em diretório temporário com processo Docker simulado;
- API + PostgreSQL para reivindicação inicial;
- migração de referências Box;
- ativação/probe de provedores por emuladores;
- upload, edição, reação, memória, duplicação e exportação mobile contra contratos reais.

### Sistema e E2E

- manifesto image-only sobe e chega a `/ready`;
- Electron empacotado encontra e inicia a stack;
- web: instalação já disponível → signup → onboarding → bot;
- mobile: URL + código → proprietário → modelo → máquina → bot → mensagem;
- mobile: recuperação de falha SSH sem exposição de segredo;
- Docker real e supervisor;
- build do site com URLs de release válidas.

### Teste manual e evidências

- vídeo do desktop desde primeira abertura até stack saudável;
- vídeo do mobile vinculando por código e concluindo o onboarding;
- vídeo da troca de máquina e uso do computador remoto;
- logs sanitizados do smoke Docker e da matriz de builds.

Credenciais reais E2B/Box só serão usadas quando fornecidas no ambiente. Na ausência delas, contratos e emuladores serão validados e a limitação será registrada.

## Tratamento de erros

Cada etapa reportará nome, estado e ação possível:

- conectividade;
- privilégios;
- Docker;
- download e checksum;
- imagens;
- volumes;
- banco;
- migrações;
- API;
- worker;
- web;
- TLS/URL;
- vínculo.

Erros devem ser retomáveis. Mensagens não expõem comandos internos desnecessários a usuários comuns, mas `quibtbot doctor --verbose` oferece detalhes sanitizados para suporte.

## Fora do escopo

- hospedar API, banco, worker, modelos ou máquinas em conta da Quibt;
- vender créditos de modelo ou computador;
- usar E2B como servidor persistente;
- migrar automaticamente dados entre um servidor local e uma VPS;
- ocultar custos de VPS, Box, E2B ou modelo;
- garantir assinatura de instaladores sem certificados externos;
- manter compatibilidade com o comportamento incorreto “uma Box compartilhada por workspace”.

## Critérios de aceite globais

1. Uma instalação limpa em Linux chega a `/ready` usando apenas o bootstrap e `quibtbot install`.
2. O instalador Electron sobe a stack sem checkout, Node ou pnpm.
3. Um celular reivindica uma instalação limpa com código de uso único e cria o proprietário.
4. O mobile permite modelo, computador, primeiro bot e configurações posteriores.
5. Desligar o notebook não interrompe o celular quando o servidor Quibt está em VPS/Box.
6. E2B e Box usados por bots permanecem isolados por bot.
7. Nenhum segredo aparece em logs, QR ou payload destinado à API Quibt.
8. Site e documentação descrevem exatamente os fluxos implementados.
9. Suites automatizadas, builds e smokes aplicáveis passam com evidência recente.
10. Limitações que dependam de certificados ou contas externas são identificadas explicitamente.
