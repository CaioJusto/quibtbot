# Modelos pelas CLIs Claude Code, Codex e Grok

O Quibt pode usar uma assinatura já conectada nas CLIs `claude`, `codex` ou `grok`. Não cole
`OPENAI_API_KEY` nem `ANTHROPIC_API_KEY`: faça login na própria CLI antes de iniciar o Quibt.

## Onde a CLI roda

A CLI roda no **host da API/worker**, em um processo separado para cada turno. Ela não roda dentro
do computador Linux do bot e não controla o Mac, Windows, navegador ou mensagens do usuário. O
adaptador entrega instruções, histórico e o recado atual e devolve o texto incremental ao mesmo fio
de conversa usado pelo runtime Pi.

API e worker procuram apenas `claude`, `codex` e `grok` no `PATH`, em `~/.local/bin` e em
`/usr/local/bin`. O worker confere o binário novamente quando começa o turno. Um nome ou caminho
arbitrário salvo como modelo nunca é executado.

Se API e worker rodam como processos do checkout (`pnpm dev`), instale e autentique a CLI para o
mesmo usuário do sistema que executa esses processos. Se rodam em contêineres ou máquinas
diferentes, a CLI e sua sessão autenticada precisam existir no ambiente de **ambos**; instalar a
CLI só no sistema físico não a torna visível dentro de um contêiner.

## Ativar

1. Confirme no terminal do host: `claude --version`, `codex --version` ou `grok --version`.
2. Faça o login usando o fluxo da própria CLI.
3. Reinicie API e worker se o `PATH` mudou.
4. Abra **Conta → Modelo → CLI no host** e escolha Claude Code, Codex ou Grok.

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
- O adaptador usa a CLI como motor de texto. As ferramentas do runtime Pi não são expostas à CLI;
  os binários são iniciados em uma pasta temporária isolada, sem permissão de escrita no host.
- Atualizações das CLIs podem mudar o formato de eventos. Os formatos JSON incrementais suportados
  são cobertos por testes com binários falsos, sem rede e sem login real.
