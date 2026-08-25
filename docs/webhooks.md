# Webhooks — acordar um bot a partir de outro sistema

Um webhook é uma porta de entrada: um sistema externo (GitHub, Stripe, um CRM, um script seu) faz um `POST` para uma URL do seu Quibt Bot, e isso acorda um bot específico com uma tarefa — sem que ninguém precise abrir o app e digitar nada. É a mesma ideia de uma rotina agendada, só que disparada por um evento em vez de por um horário.

Cada webhook pertence a **um bot**. A entrega cai na conversa daquele bot como uma tarefa e vira uma resposta na mesma conversa, com histórico e tudo.

## Para quem não é técnico

1. Abra as configurações do bot → **Webhooks** → **Novo webhook**. Dê um nome (ex.: "Build falhou") e, se quiser, um texto fixo do que o bot deve fazer quando o webhook disparar. Sem texto fixo, o bot tenta entender a tarefa a partir do que a entrega trouxer.
2. O Quibt gera uma **credencial exibida uma única vez**: um endereço e uma senha longa (o "segredo"). Copie os dois agora — depois de fechar essa tela, o segredo não aparece de novo (só girando, o que gera um novo). A credencial continua válida para quantas entregas você quiser até você girar o segredo.
3. Cole esse endereço e essa senha na configuração de webhook do outro sistema (GitHub, Stripe, Zapier, um script seu, etc.). A maioria pede um cabeçalho `Authorization: Bearer <segredo>` — é a forma preferida. Guarde a senha como guardaria uma senha de banco: quem a tiver pode acordar esse bot.
4. Quando o outro sistema disparar, aparece uma linha em "Atividade" nesse painel, e a resposta do bot aparece na conversa normal dele. Dá para pausar o webhook a qualquer momento sem apagá-lo, girar o segredo se ele for exposto por engano, ou apagar de vez.

**De onde vem o endereço público?** Isso depende de onde o seu Quibt Bot está rodando — o Quibt não hospeda nem revende nada disso:

- **Numa VPS que você já mantém rodando**: o próprio domínio público dessa instalação, por exemplo `https://quibt.example.com/hooks/wh_abc123`. Quem já tem uma VPS com HTTPS na frente do Quibt Bot não precisa configurar mais nada.
- **No seu PC**: seu computador não tem um endereço público por padrão. Para o GitHub/Stripe/etc. — e o celular fora do Wi-Fi deste PC — conseguirem chegar até ele, você mesmo configura — e, se for pago, paga direto ao provedor, nunca ao Quibt — um **Cloudflare Tunnel** ou um **Tailscale Funnel** apontando para `http://127.0.0.1:5173`. Qualquer um dos dois expõe seu Quibt local num endereço público que aponta de volta para o seu PC. O mesmo `https://` salvo em **Ajustes → Webhooks** ou **Ajustes → Celular → Qualquer rede** entra no QR do celular. O Quibt Bot não fornece, não hospeda e não vende Cloud, relay ou túnel — essa parte é sempre sua.

Se o sistema do outro lado não conseguir mandar um cabeçalho `Authorization` personalizado, existe um modo de compatibilidade: uma **URL privada** que já leva a senha embutida no próprio caminho (`.../hooks/wh_abc123/whsec_...`). Funciona, mas qualquer um com essa URL completa consegue acordar o bot — prefira sempre o `Bearer` quando o sistema do outro lado permitir escolher.

Apagar um webhook cancela na hora qualquer trabalho que ele tenha disparado e ainda esteja rodando (incluindo o que esse trabalho tenha, por sua vez, mandado outro bot fazer) — não fica nada "correndo sozinho" depois que o gatilho já não existe mais.

Toda tarefa que chega por webhook passa primeiro pelo bot sozinho, sem ninguém olhando a tela. Por isso, qualquer ferramenta que possa fazer algo sensível (rodar um comando, mexer num arquivo fora do esperado, gastar dinheiro) ainda para e pede aprovação humana antes de agir — mesmo que o bot esteja configurado para aprovar essas coisas automaticamente quando alguém está por perto. "Sempre permitir" de um webhook nunca vira permissão permanente: no máximo libera aquela vez.

## Detalhes técnicos

### Criar e gerenciar

Pelo RPC autenticado (usado pelo painel Webhooks):

- `webhooks.create({ botId, name, prompt?, eventTypes? })` → `{ webhook, credential }`. `credential` só aparece nesta resposta e na de `rotateSecret` — nunca em `list` ou `attempts`.
- `webhooks.list({ botId })`, `webhooks.update`, `webhooks.remove`, `webhooks.rotateSecret`, `webhooks.testRun`, `webhooks.attempts({ webhookId, limit? })`.
- `deployment.get()` / `deployment.update({ webhookPublicUrl })` — só o dono do deployment lê/escreve a URL pública usada para montar `credential.endpointUrl`/`credential.url`; sem essa URL configurada, cai no `API_URL` do próprio processo.

Toda credencial é construída a partir de `webhookPublicUrl` (ou `API_URL` como fallback) — nunca do cabeçalho `Host` de uma requisição, para que ninguém consiga forjar a credencial que aparece na tela de alguém.

### Entregar um evento

```bash
curl -X POST https://quibt.example.com/hooks/wh_abc123 \
  -H "Authorization: Bearer whsec_XXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <id-único-desta-entrega>" \
  -d '{"task": "Revise o build que acabou de falhar"}'
```

Três formas de autenticar, nessa ordem de preferência:

1. `Authorization: Bearer <segredo>` (preferida).
2. `X-Quibt-Webhook-Secret: <segredo>` (para quem não pode customizar o esquema do `Authorization`).
3. URL privada `POST /hooks/:endpointId/:secret` (modo de compatibilidade — só use quando as duas anteriores forem impossíveis). Quem opera a instalação deve redigir esse caminho nos logs do proxy (`$request_uri` no nginx, Caddy, load balancer): o segredo vai na URL e aparece no access log. Prefira Bearer.

Corpo aceito como `application/json`, `application/x-www-form-urlencoded` ou texto puro; um corpo vazio com `Content-Type: application/json` é tratado como `{}` (um "ping" de verificação), não como erro. Limite de corpo: **256 KiB** — acima disso a entrega é rejeitada antes mesmo de terminar de ler o corpo.

Cabeçalhos que o Quibt lê, se presentes (o primeiro que existir, nessa ordem):

- **Id da entrega** (para deduplicar): `Idempotency-Key`, `X-Webhook-Id`, `X-GitHub-Delivery`, `Webhook-Id`.
- **Nome do evento** (para os filtros por tipo): `X-GitHub-Event`, `X-Webhook-Event`, `X-Event-Type`, `Ce-Type`.

Cada um é limitado a 200 caracteres antes de ser guardado ou usado numa chave de deduplicação.

Como o Quibt decide o que pedir ao bot, em ordem de prioridade: (1) o **prompt configurado** no webhook, se houver; (2) o campo `task` (ou `message`) do corpo, se for JSON com um desses campos de texto; (3) um resumo conservador padrão. O corpo recebido é sempre citado ao bot como **dado não confiável do evento** — nunca como instrução — mesmo quando ele contém texto que pareça um comando.

### Resposta e códigos de status

Toda resposta de `/hooks/*` é `Content-Type: application/json` com `Cache-Control: no-store`, e nunca ecoa detalhes internos (stack trace, erro de driver, etc.).

| Status | Significado |
| --- | --- |
| `202` | Aceito. Corpo `{ accepted: true, duplicate, runId }`. `duplicate: true` quando esse `Idempotency-Key` (ou id equivalente) já tinha sido processado — `runId` é o da execução original, nenhuma nova é criada. `runId: null` quando o evento foi **ignorado** por filtro de tipo (`eventTypes`), mesmo assim sem erro. |
| `400` | Corpo JSON malformado. |
| `401` | Segredo ausente ou incorreto, ou endpoint inexistente — de propósito **indistinguível** de um segredo errado, para não revelar quais ids de webhook existem. |
| `409` | Webhook pausado. |
| `410` | O bot dono do webhook não existe mais (ou perdeu a conversa) — a entrega chegou tarde demais. |
| `413` | Corpo maior que 256 KiB. |
| `429` | Limite de taxa ou de trabalho pendente excedido (ver abaixo). |
| `500` | Falha inesperada no processamento — genérica, nunca expõe a causa interna. |

A ordem importa: a autenticação é verificada **antes** de qualquer leitura ou validação do corpo, então um segredo errado com um corpo gigante e malformado ainda responde `401`, não `413` nem `400`.

### Idempotência

`Idempotency-Key` (ou o id equivalente lido dos outros cabeçalhos) é a chave de deduplicação por webhook: reenviar a mesma entrega — porque o outro lado não recebeu a resposta a tempo e tentou de novo, por exemplo — sempre retorna o `runId` já criado, nunca dispara um segundo trabalho. Sem esse cabeçalho, cada `POST` é tratado como um evento novo.

### Limites de taxa

Dois níveis independentes, para dois tipos de abuso diferentes:

- **Depois de autenticado** (segredo correto): até **10 entregas aceitas por minuto**, por webhook. Além disso, no máximo **3 execuções não terminadas** (rodando ou esperando aprovação) por webhook ao mesmo tempo — protege o bot de um evento que dispara mais rápido do que ele consegue trabalhar o acumulado. Os dois contam só entregas que passaram da autenticação e não eram duplicadas.
- **Antes de autenticar** (qualquer tentativa, inclusive segredo errado ou endpoint inventado): **30 tentativas por minuto** por combinação (IP, grupo de endpoints) e um teto geral de **60 por minuto por IP**, que fecha a porta para quem tenta adivinhar ids de webhook variando o caminho.

Atrás de um proxy reverso (nginx, Caddy, um load balancer), configure `TRUSTED_PROXY_IPS` com os endereços desse proxy — só assim o Quibt confia no `X-Real-IP`/`X-Forwarded-For` que ele encaminha para aplicar esses limites por IP de origem real, em vez de por IP do proxy. Sem essa configuração, cabeçalhos de IP encaminhado são ignorados e todo tráfego atrás do proxy conta como um único IP.

### Aprovação humana para ferramentas protegidas

Uma entrega de webhook aciona uma execução **sem supervisão** (`trigger: "webhook"`, propagado a qualquer trabalho que ela por sua vez dispare em outro bot). Nessas execuções:

- Ferramentas intrinsecamente seguras (memória, lembrar, listar colegas, etc.) continuam liberadas.
- Qualquer ferramenta que normalmente pediria aprovação continua pedindo — mesmo que o bot tenha "aprovar automaticamente" ligado ou aquele comando específico esteja em "sempre permitir". Ninguém está olhando a tela para responder a um card, então nada é assumido como aprovado de antemão.
- Se, mesmo assim, uma dessas execuções pausar e alguém responder "sempre permitir" a um card, isso vira aprovação só daquela vez — não muda a lista de "sempre permitir" do bot.

### Exclusão e pausa

- **Pausar** (`active: false`) rejeita novas entregas com `409` mas não toca em execuções já em andamento.
- **Apagar** cancela imediatamente qualquer execução ainda não terminada que aquele webhook tenha causado — inclusive as que essa execução, por sua vez, tenha disparado em outro bot (uma resposta de colega, um bot criado na hora) — e nunca deixa nada "correndo sozinho" depois que o webhook já não existe.

### Sem Cloud, sem relay, sem túnel

O Quibt Bot é local-first e open source: quem roda o processo escolhe onde ele mora (esta máquina, uma VPS própria, E2B, Box) e escolhe como expor `/hooks/*` para a internet, se quiser. O Quibt não opera, não hospeda, não revende e não intermedeia nenhum túnel, relay ou serviço de Cloud para isso — Cloudflare Tunnel e Tailscale Funnel citados aqui são exemplos de ferramentas de terceiros que você mesmo configura e, se optar por um plano pago dessas ferramentas, paga direto ao provedor delas.
