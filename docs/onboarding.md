# Primeiros passos no Quibt Bot

Este guia é para quem nunca mexeu em servidor, Docker ou chave de API. O Quibt Bot é **open source e local-first**: você instala, traz o seu modelo, escolhe onde o computador dos bots vai rodar, e cria o primeiro personagem.

Duas perguntas guiam este guia: **Onde o Quibt fica ligado?** (o passo 1 abaixo — este
computador, sua VPS ou uma VM da Box) e **Onde os bots trabalham?** (o passo 4 — Docker, VPS,
E2B ou Box). São escolhas independentes.

Não existe plano de tokens da Quibt no caminho público. Você paga o modelo (OpenRouter, Ollama no seu PC, ou a assinatura que já tem) e, se escolher nuvem, paga a E2B ou a Box na conta **deles**.

## 1. Instalar

Escolha um caminho.

**App de desktop (mais fácil)**

1. Baixe o instalador em [quibt.com.br](https://quibt.com.br) ou nas [Releases do GitHub](https://github.com/CaioJusto/quibtbot/releases/latest):
   - Mac (Apple silicon): `QuibtBot.dmg` — confira o `signing-status-mac.json` da versão disponível. Se ele indicar um build sem assinatura, o macOS avisa; na primeira vez, clique com o botão direito → Abrir. Mac Intel: ainda sem instalador — só rodando a partir do código-fonte (veja o README).
   - Windows: `QuibtBot-setup.exe` — instalador de teste 64 bits, sem assinatura; o SmartScreen avisa: Mais informações → Executar assim mesmo. Instale o Docker Desktop por conta própria.
   - Linux: `QuibtBot.AppImage` — AppImage x64 de teste, sem assinatura; precisa de libfuse2, marque como executável e instale o Docker (Engine ou Desktop) por conta própria.
2. Abra o Quibt Bot. Se o stack local ainda não estiver de pé, o app mostra um assistente.
3. No Mac, o assistente encontra Docker Desktop, Colima e Homebrew sozinho. Se nenhum Docker existir, baixa o DMG oficial certo para o processador, confere a assinatura da Docker Inc. e a notarização da Apple, pede a senha do Mac uma vez, abre o Docker e continua. Não precisa instalar o Docker antes.

**Por um comando** (Mac ou Linux, sem o app): cole no terminal

```bash
curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/f75c7c22b79a75cf682e3e461e6d61ea58202101/scripts/install.sh \
  | QUIBT_RELEASE=0.2.18 sh
```

Ele baixa o `quibtbot` certo para a sua máquina, confere o SHA-256 publicado e roda `quibtbot install`. No fim imprime o endereço e o código para o celular. Para sair: `quibtbot uninstall` (ou, no app, **Quibt Bot → Desinstalar**).

**Pelo código** (se alguém da casa já programa): siga o “Run locally” do [README](../README.md).

## 2. Criar a sua conta

Abra o app e toque em **Começar agora**: a primeira conta pede só o seu nome — o código que o instalador mostrou já provou que o computador é seu, então não há e-mail nem senha para inventar. Essa primeira pessoa vira dona do deploy e é quem escolhe a máquina. Para entrar em outro aparelho depois, peça um código em **Conta → Celular**.

**Quem entra sozinho, e quem não entra.** No computador onde o Quibt roda, o app de desktop abre já
dentro: ele prova que tem o segredo local da instalação (o arquivo `quibt.env`), com uma permissão
que vale um minuto e serve uma vez só. Se esse arquivo não existir, ou se o app estiver apontado
para um servidor remoto, ele cai na tela de login normal — de propósito.

Numa instalação de LAN ou de VPS, a entrada automática não existe: todo mundo entra por senha ou por código de pareamento.
O motivo é simples: um vizinho do mesmo Wi-Fi chega ao servidor com o mesmo endereço do dono, então
endereço não prova quem está no teclado. No celular e em qualquer outro aparelho da rede, a entrada
é **sempre** por código.

## 3. Trazer o modelo

Depois do nome, o app vai direto às decisões — modelo, máquina e o primeiro bot. A tela da máquina confirma o Docker desta máquina; quem já instalou apontando para Box, E2B ou um supervisor remoto pula esse passo (a escolha já está feita, e continua em Ajustes → Máquina). Não há telas de apresentação no meio.

Três jeitos, nesta ordem na tela. Pode pular e configurar depois, mas sem modelo o bot não responde.

| Jeito | O que fazer | Quem paga |
| --- | --- | --- |
| Minha assinatura | Entre com ChatGPT Plus/Pro, GitHub Copilot ou SuperGrok. O app mostra um código para você colar no site deles. | A assinatura que você já paga |
| Chave OpenRouter | Crie a chave em [openrouter.ai/keys](https://openrouter.ai/keys), copie e cole no Quibt. | A sua conta OpenRouter, por uso |
| Modelo local | Instale [Ollama](https://ollama.com) (ou LM Studio). A URL padrão é `http://127.0.0.1:11434`. | Ninguém. Roda no seu PC |

Na assinatura, **Continuar só libera depois que o login termina** — antes disso o botão diz “Entre na assinatura primeiro”. Salvar o provedor sem credencial fazia o bot responder “não tenho um modelo conectado” no primeiro recado. A aba só lista as três assinaturas acima: são as que o app sabe entrar.

A chave é conferida no provedor **antes** de ser guardada. Colada errada, a tela diz “Chave recusada pelo OpenRouter”; sem saldo, “Sem crédito na OpenRouter”; com o Ollama fechado, “O Ollama não respondeu em http://127.0.0.1:11434”. Nada é salvo até o provedor confirmar — e aí aparece “Chave confirmada ✓”.

O modelo local só vale num endereço **deste computador** ou num **endereço público**. Use
`http://127.0.0.1:11434`, `localhost` ou, se o Quibt roda em Docker, `host.docker.internal`. Um
endereço de rede privada (192.168.x, 10.x, 172.16–172.31.x) e o endereço de metadados da nuvem
(169.254.169.254) são recusados antes de qualquer conexão, e a tela diz: “O Ollama precisa estar no
seu computador ou num endereço público”. Um servidor seu com endereço público (um vLLM, por
exemplo) continua funcionando. Quando o Quibt não acha o modelo, a resposta é sempre a mesma frase
— ele não conta quais portas estão abertas na sua rede.

O modelo sugerido evita os que a OpenAI recusa em conta ChatGPT (a família `codex-spark` só responde a quem paga por chave de API). Você troca no seletor de modelo dessa mesma tela.

## 4. Escolher a máquina

Esta tela só aparece para quem é dono do install. Toque numa opção e **leia o quadro que abre** — ele diz o que instalar, onde clicar e o que vai ser cobrado.

| Opção | Em uma frase | O que você precisa |
| --- | --- | --- |
| Nesta máquina (Docker) | Os bots usam este computador. | Docker Desktop aberto |
| Minha VPS | Os bots usam o seu servidor. | URL + token do supervisor |
| E2B | Cada bot ganha um desktop isolado na nuvem da E2B. | Conta e chave em e2b.dev |
| Box | Cada bot ganha uma VM Ubuntu na Box. | Conta e chave em box.ascii.dev |

Receitas Hetzner / DigitalOcean / “qualquer VPS” são atalhos para a opção Minha VPS.

Quer usar do celular fora de casa, sem depender do notebook ligado? Instale o Quibt **inteiro**
na VPS com `quibtbot install`. Se a máquina tiver IP público e as portas 80 e 443 livres, o
instalador liga o HTTPS sozinho: escolhe um nome como `quibt-a1b2c3d4.203.0.113.9.sslip.io`
(um DNS público que aponta para o próprio IP) e tira o certificado no Let's Encrypt. Você não
precisa de domínio, e a Quibt não põe domínio nenhum no meio. O QR já sai com `https://`.
Se as portas estiverem ocupadas por outro site, ele avisa e fica só na máquina — aí é o caso
de colocar atrás do seu proxy. `quibtbot install --local` deixa local mesmo numa VPS limpa.

O passo a passo de cada uma está em [computers.md](./computers.md) e no próprio app (o mesmo texto).

Toque em **Testar** antes de salvar. Se algo faltar, a tela diz o que colar.

## 5. Criar o primeiro bot

Escolha uma cara, um nome e um cargo. Toque em **Abrir o Quibt Bot**. Mande uma mensagem. O painel do computador mostra a tela Linux daquele bot.

## Como vários bots dividem o computador

- **Docker ou VPS:** é o **mesmo** computador (a mesma imagem Linux). Cada bot tem a **própria tela** — um desktop, não uma aba do Chrome. Arquivos da casa são compartilhados. A parede parece igual; as janelas de cada bot são outras.
- **E2B ou Box:** cada bot tem o **próprio** computador na nuvem. Nada é compartilhado entre eles.

Isso não é o modelo do Crocbot (“Croc Pot”), que ou isola um container por agente ou controla abas do Chrome. No Quibt, no Docker, pense num escritório: um PC, um monitor por pessoa.

## Desinstalar

Instalar põe containers, um container por computador de bot, três imagens e uma pasta de dados na máquina — apagar o app sozinho deixa tudo isso para trás (e a próxima abertura nem mostra o assistente, porque o stack continua no ar). No app: **Quibt Bot → Desinstalar o Quibt Bot…** (pergunta uma vez, pode manter os seus dados, e manda o app para o Lixo). No terminal: `quibtbot uninstall`, com `--keep-data` para guardar banco e arquivos dos bots. O Docker fica.

## Se travar

| Sintoma | O que tentar |
| --- | --- |
| “Docker não responde” / “Abra o Docker Desktop (a baleia)” | Ao abrir, o app já abre o Docker Desktop e religa o Quibt sozinho (“Ligando o Quibt Bot…”, cerca de um minuto depois de ligar o Mac). Se a tela mostrar um erro, clique em **Tentar de novo**; se pedir a baleia, abra o Docker Desktop pela pasta Aplicativos e tente de novo. Confira também se há uma confirmação de senha do macOS atrás da janela. Um download que travou é refeito sozinho até três vezes, e o que já baixou fica guardado. |
| Bot não responde | Toque em **Conectar modelo** no aviso da conversa (ou abra **Conta → Modelo**) e cole a chave, entre na assinatura, ou confirme que o Ollama está aberto. |
| Tela preta no computador | Mande outra mensagem, ou toque em Assumir controle. No Docker, o desktop só sobe quando o bot precisa dele. |
| Celular não conecta | No computador, abra **Conta → Conectar o celular**. No app móvel, **Ler o QR do computador** é a primeira opção. Os dois aparelhos devem estar no mesmo Wi-Fi; no iPhone, aceite **Rede Local** ou libere em **Ajustes → Privacidade e Segurança → Rede Local → Quibt Bot**. Fora dessa rede, ative o acesso por Tailscale no computador e gere outro QR. |
| Quero entrar em outro aparelho | Num aparelho já conectado: **Conta → Celular → Liberar entrada**. Leia o QR ou digite o código de oito caracteres em **Entrar com código**. Vale cinco minutos, uma vez só. |
| Esqueci a senha e não chega e-mail | Numa instalação sem `RESEND_API_KEY` não existe e-mail para chegar. Abra **Esqueceu a senha?** no navegador **do próprio computador**: o link aparece ali mesmo. De outro aparelho não funciona, e é de propósito. |

Trocar de máquina depois: **Ajustes → Máquina**. Um computador que já está ligado fica no provedor antigo até a próxima vez que ele bootar.

Se o app de desktop já estiver conectado a uma VPS, o QR mostrado por ele leva o celular direto
para essa mesma VPS. Nesse caso o notebook é apenas a tela de controle e pode ser desligado depois;
o servidor e os bots continuam na VPS.
