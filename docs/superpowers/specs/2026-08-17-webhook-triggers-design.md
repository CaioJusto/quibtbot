# Gatilhos por webhook

## Objetivo

Permitir que um sistema externo envie um evento a um bot individual do Quibt e crie uma tarefa real no chat desse bot. A funcionalidade deve operar tanto numa instalação pública em VPS quanto no computador da pessoa, usando uma URL de túnel configurada por ela.

O Quibt não oferece, revende ou opera Cloud, relay ou túnel. O bot sempre usa o modelo, as permissões e a máquina que a pessoa já escolheu.

## Escopo funcional

- Criar, listar, editar, pausar, reativar e excluir webhooks por bot.
- Rotacionar o segredo e invalidar imediatamente o anterior.
- Aceitar eventos por segredo Bearer ou por URL privada para emissores sem headers personalizados.
- Aceitar JSON, formulário URL-encoded e texto.
- Usar uma instrução fixa opcional; sem ela, usar `task` ou `message` do payload; sem nenhum dos dois, pedir um resumo conservador do evento.
- Filtrar tipos de evento opcionalmente.
- Deduplicar reenvios que tenham ID de entrega.
- Registrar tentativas aceitas, duplicadas, ignoradas e rejeitadas.
- Mostrar atividade e abrir a execução correspondente no chat.
- Fazer a primeira entrega válida executar imediatamente.

Grupos de bots, assinaturas específicas de provedores e relay hospedado ficam fora desta versão.

## Arquitetura

O receptor usa a API existente do Quibt, fora do oRPC autenticado:

```text
Sistema externo
  -> POST /hooks/:endpointId[/secret]
  -> autenticação, parsing, limites e idempotência
  -> transação PostgreSQL cria tentativa, Task e Run(trigger="webhook")
  -> job run.continue
  -> worker/executor existente
  -> eventos do thread e atividade na interface
```

Os endpoints administrativos permanecem no contrato oRPC e exigem sessão e associação ao workspace. O endpoint de ingresso não usa sessão; o endpoint aleatório e o segredo resolvem o webhook e, por consequência, seu workspace, usuário e bot.

## Persistência

### `Webhook`

- `id`, `endpointId`, `workspaceId`, `userId`, `botId`
- `name`, `prompt`, `active`, `eventTypes`
- `secretHash`
- `deliveryCount`, `lastReceivedAt`, `lastRunId`
- `createdAt`, `updatedAt`

O segredo possui 256 bits de entropia, prefixo identificável e é mostrado somente na criação ou rotação. Apenas seu SHA-256 é persistido. `endpointId` também é aleatório e possui índice único.

### `WebhookAttempt`

- `id`, `webhookId`, `receivedAt`
- `outcome`, `statusCode`
- `eventName`, `preview`, `deliveryId`, `runId`, `reason`

Cada requisição gera uma tentativa, inclusive retries duplicados.

### `WebhookDelivery`

- `id`, `webhookId`, `externalId`, `runId`, `receivedAt`

Uma restrição única por webhook e `externalId` fornece idempotência persistente quando o emissor envia um identificador. Separar o recibo da tentativa permite registrar o retry como duplicado sem colidir com a entrega original. Tentativas e recibos antigos podem ser podados posteriormente, sem fazer parte do fluxo síncrono desta versão.

## Administração

O contrato oferece operações para:

- `webhooks.list({ botId })`
- `webhooks.create(...)`
- `webhooks.update(...)`
- `webhooks.remove(...)`
- `webhooks.rotateSecret(...)`
- `webhooks.testRun(...)`
- `webhooks.attempts(...)`
- `deployment.update({ webhookPublicUrl })`

Criação e rotação retornam uma credencial uma única vez: endpoint, segredo e URL privada. As listagens nunca retornam hash ou segredo.

## Ingresso HTTP

Rotas:

- `GET /hooks/health`
- `POST /hooks/:endpointId`
- `POST /hooks/:endpointId/:secret`

Autenticação:

- `Authorization: Bearer <secret>`
- `X-Quibt-Webhook-Secret: <secret>`
- segredo no último segmento da URL

Metadados reconhecidos:

- entrega: `Idempotency-Key`, `X-Webhook-Id`, `X-GitHub-Delivery`, `Webhook-Id`
- evento: `X-GitHub-Event`, `X-Webhook-Event`, `X-Event-Type`, `Ce-Type`

O receptor autentica antes de armazenar ou interpretar o corpo. O corpo é limitado a 256 KiB. O payload serializado para o modelo é limitado e truncado de forma explícita.

## Prompt e confiança

O texto enviado ao modelo separa instruções e dados:

```text
[INSTRUÇÕES DO WEBHOOK]
...
[/INSTRUÇÕES DO WEBHOOK]

[DADOS NÃO CONFIÁVEIS DO EVENTO]
metadados
payload
[/DADOS NÃO CONFIÁVEIS DO EVENTO]
```

Conteúdo do payload nunca é tratado implicitamente como instrução, exceto os campos autenticados `task` ou `message` quando o webhook não possui instrução fixa. A interface mostra uma versão compacta, mas o texto armazenado preserva os marcadores para turnos posteriores.

## Limites e políticas

- Dez novas entregas por minuto por webhook, calculadas em dados persistentes.
- Até três runs não concluídos por webhook.
- Reenvio duplicado não consome limite nem cria nova tarefa.
- Webhook pausado retorna `409`.
- Bot removido retorna `410`; a exclusão em cascata remove seus webhooks.
- Pausar ou excluir cancela runs ainda enfileirados; uma execução já iniciada continua.
- Runs com `trigger="webhook"` são não supervisionados e nunca recebem autoaprovação nem concessões `alwaysAllow`, inclusive em delegações.
- O endpoint responde `202` quando aceito, duplicado ou ignorado. Conclusão do agente permanece assíncrona.

Erros previstos: `400`, `401`, `404`, `405`, `409`, `410`, `413`, `429` e `500`.

## Interface

A configuração aparece nas opções do bot, usando o sistema visual claro e os tokens existentes:

- lista de webhooks do bot e seus estados;
- editor de nome, instrução fixa e tipos aceitos;
- ações de pausar, reativar, excluir e rotacionar;
- cópia de endpoint, segredo, URL privada e comando `curl`;
- atividade recente com estado, resumo e ação “Abrir no chat”.

A configuração do servidor inclui `URL pública de webhooks`:

- numa VPS, usa o domínio público da instalação;
- num computador local, a pessoa cola a URL do próprio Cloudflare Tunnel, Tailscale Funnel ou solução equivalente.

A interface explica que o túnel é externo, configurado e eventualmente pago diretamente pela pessoa. Não existe CTA, plano ou infraestrutura Cloud do Quibt.

## Testes

O desenvolvimento seguirá teste primeiro:

1. Contratos e helpers de segredo, parsing e prompt.
2. Integração PostgreSQL para CRUD, isolamento, hash, rotação, idempotência, limites e criação transacional de Task/Run.
3. HTTP para autenticação, formatos, headers, limites e códigos.
4. Executor para impedir autoaprovação em runs de webhook.
5. Jornada completa: POST -> `run.continue` -> resposta no thread.
6. Interface: operações administrativas, cópia e atividade.
7. Teste manual no navegador, incluindo criação, chamada real e abertura do chat, com gravação curta.

## Critérios de aceite

- A mesma implementação funciona por domínio de VPS e por URL de túnel local.
- Uma entrega válida cria exatamente uma tarefa e um run no bot correto.
- Um retry com o mesmo ID retorna o run original.
- Segredos não aparecem em listagens, eventos, logs ou banco em texto claro.
- Payload não confiável permanece delimitado no contexto do modelo.
- Runs de webhook exigem aprovação humana para ferramentas protegidas.
- Todas as funções administrativas e a atividade ficam disponíveis sem copiar o design do OpenMausBot.
- Nenhuma tela sugere que o Quibt vende Cloud, hospedagem ou túnel.
