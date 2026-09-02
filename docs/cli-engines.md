# Modelos pelas CLIs Claude Code, Codex e Grok

O Quibt pode usar uma assinatura já conectada nas CLIs `claude`, `codex` ou `grok`. Não cole
`OPENAI_API_KEY` nem `ANTHROPIC_API_KEY`: faça login na própria CLI antes de iniciar o Quibt.

## Onde a CLI roda

A CLI roda no **host da API/worker**, em um processo separado para cada turno. Ela não roda dentro
do computador Linux do bot e não controla o Mac, Windows, navegador ou mensagens do usuário. O
adaptador entrega instruções, histórico e o recado atual e devolve o texto incremental ao mesmo fio
de conversa usado pelo runtime Pi.

API e worker procuram `claude`, `codex` e `grok` no `PATH`, em `~/.local/bin` e em
`/usr/local/bin`. Dá para registrar **uma** CLI extra que fala ACP, com o caminho absoluto em
`QUIBT_EXTRA_ACP_CLI` — só `~/.local/bin` ou `/usr/local/bin`, sem metacaracteres de shell. Se o
binário não existir, essa engine some do catálogo; a frota não cai. Um nome ou caminho
arbitrário salvo como modelo nunca é executado. O worker confere o binário novamente quando
começa o turno.

Se API e worker rodam como processos do checkout (`pnpm dev`), instale e autentique a CLI para o
mesmo usuário do sistema que executa esses processos. Se rodam em contêineres ou máquinas
diferentes, a CLI e sua sessão autenticada precisam existir no ambiente de **ambos**; instalar a
CLI só no sistema físico não a torna visível dentro de um contêiner.

## Ativar

1. Confirme no terminal do host: `claude --version`, `codex --version` ou `grok --version`.
2. Faça o login usando o fluxo da própria CLI.
3. Reinicie API e worker se o `PATH` mudou.
4. Abra **Conta → Modelo → CLI no host** e escolha Claude Code, Codex, Grok ou a CLI ACP extra.

No primeiro acesso, a API grava somente um marcador da escolha; não copia tokens nem arquivos de
sessão. Se nenhuma CLI for encontrada, onboarding e Configurações dizem isso e continuam mostrando
OpenRouter, assinaturas OAuth e Ollama/LM Studio.

O processo filho recebe apenas variáveis básicas do sistema e os diretórios de configuração da
CLI. Segredos do deploy (`DATABASE_URL`, chaves de criptografia, chaves de provedores e credenciais
de sandbox) não são herdados; em especial, chaves OpenAI, Anthropic e xAI não são repassadas, para a
CLI usar a sessão da assinatura criada pelo seu próprio login.

## Limites atuais

- Cada turno é independente; sessões de conversa da CLI não são retomadas. O histórico necessário
  vem do fio do Quibt.
- A CLI agora tem mãos no computador do bot. Claude Code, Codex e Grok recebem as mesmas
  ferramentas (shell, arquivos, print, `computer`) pelo MCP da CLI; a CLI ACP extra fala ACP e
  usa o mesmo servidor. Os comandos vão ao sandbox já escolhido (Docker, VPS, E2B, Box, Daytona)
  — não há um segundo computador. Operações destrutivas ou com cara de segredo passam pelo
  corretor de permissão do Quibt; a CLI não libera sozinha.
- A CLI **não** controla o Mac ou o Windows do host. O processo continua numa pasta temporária
  isolada, sem escrita no seu desktop, e as ferramentas nativas de host da CLI ficam desligadas.
- Atualizações das CLIs podem mudar o formato de eventos. Os formatos JSON incrementais e o
  encaminhamento MCP/ACP são cobertos por testes com binários falsos, sem rede e sem login real.
