# Importação de design do Grok Bot 0.18

Este trabalho usa a reconstrução não oficial do Grok Bot 0.18 apenas como
especificação visual. A implementação é código novo do Quibt sobre
`origin/main` (`13274ea`). Nenhum fonte recuperado, chunk de renderer ou
binário foi copiado.

## O que ficou

O pedido é o **desenho do app ao abrir** (sidebar, inbox, cromo da janela) e o
**desenho dentro do chat** (cabeçalho, bolhas, composer), com as funções que o
Quibt já tinha. Os tokens claros `--qb-*` continuam a valer.

O CSS disso está em `apps/web/src/styles-grok-chat.css` e só restiliza classes
já existentes.

## O que foi revertido

A janela de ajustes no estilo Grok (Roteador / Uso, duas colunas 860×620) **saiu
de uso**. O Quibt já tem as próprias configurações e é essa superfície que
permanece — restaurada de `origin/main`.

Também saíram superfícies de produto que não existiam no Quibt: paleta de
comandos, busca no fio, faixa de reconexão, colapso da lista, overlay novo do
computador e as seções Roteador/Uso.

## Como ver

Siga o `README.md`, abra `http://127.0.0.1:5173` e entre no app. A home é a
inbox; o chat é o fio já existente. Configurações continuam pelo menu da conta.

## Screenshots

- `docs/assets/quibt-app-open.png` — app aberto, inbox
- `docs/assets/quibt-chat-open.png` — conversa

## Segunda leva (funções, não desenho)

A primeira leva trouxe só densidade visual. Esta traz duas funções do repositório
reconstruído, escritas do zero sobre o Quibt — nenhum arquivo de lá foi copiado, e
a licença daquele material continua indefinida (`PROVENANCE.md` do repositório de
origem).

- **Paleta de comandos (`⌘K` / `Ctrl+K`).** Busca bots, grupos e ações num campo só.
  A comparação ignora acento e pontuação, porque quem escreve em português digita
  "joao" para achar "João". Modelo puro e testado em `apps/web/src/lib/command-palette.ts`;
  a tela é `apps/web/src/pages/CommandPalette.tsx`.
- **Estado vivo do fio.** `startLiveFeed` passou a dizer em que pé está
  (`connecting` / `connected` / `reconnecting` / `offline`). O `connect` recebe um
  segundo argumento, `opened`, que o chamador dispara quando o fluxo abre mesmo — sem
  isso o estado não passaria de "conectando", porque `connect` só resolve quando o
  fluxo acaba. O chat da web mostra uma faixa discreta enquanto tenta e some sozinha
  quando volta. O celular usa o mesmo `startLiveFeed` e continua igual: o argumento é
  opcional e quem não passa `onStatus` não vê diferença.

Fora da leva, por escolha: roteador de inferência local (usar o login de Claude Code /
Codex que já está na máquina), contagem de uso por provedor e ponte MCP para o provedor
roteado. São as três coisas mais valiosas que sobraram lá.
