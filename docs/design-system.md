# Sistema visual

O Quibt tem um só sistema visual, do onboarding ao painel. Ele é **claro**: assenta em
`#FCFCFC`, com cinzas neutros e um azul só. Não existe modo noturno — se você encontrar uma
superfície escura fora da prévia do computador, é resto de código antigo, não uma escolha.

Os valores não foram inventados: foram medidos em pixel, um a um, antes de virarem token.
A régua daquela medição era evidência local e saiu do repositório; o que vale agora são os
tokens em `packages/ui-tokens`, que qualquer tela pode conferir.

## Onde os tokens vivem

| Arquivo | Para quem |
| --- | --- |
| `packages/ui-tokens/src/tokens.css` | web e desktop — a fonte da verdade |
| `packages/ui-tokens/src/index.ts` | quem não escreve CSS (`tokens`, `radii`, `textSizes`) |

O web importa o CSS uma vez em `apps/web/src/styles.css`. Use sempre a variável, nunca o
valor: `bg-[var(--qb-surface)]`, não `bg-[#EEEEEE]`.

## Cor

| Token | Valor | Papel |
| --- | --- | --- |
| `--qb-canvas` | `#FCFCFC` | conversa, painéis, modais, diálogos |
| `--qb-rail` | `#F7F7F7` | lista de bots e faixas laterais |
| `--qb-surface` | `#EEEEEE` | bolha do bot |
| `--qb-surface-2` | `#F0F0F0` | cartão agrupado, botão sutil, linha ativa |
| `--qb-inset` | `#EBEBEB` | campo embutido, como a busca da lista |
| `--qb-tile` | `#E5E5E5` | quadrado de ícone |
| `--qb-hairline` | `#E0E0E0` | divisores e bordas de campo |
| `--qb-ink` | `#141414` | texto principal |
| `--qb-ink-strong` | `#070707` | bolha do usuário, chave ligada, botão primário |
| `--qb-muted` | `#707070` | texto secundário |
| `--qb-muted-2` | `#9E9E9E` | data, cabeçalho de seção |
| `--qb-accent` | `#3C82F6` | ação primária, foco, link |
| `--qb-danger` | `#EB4145` | apagar |
| `--qb-danger-soft` | `#EDE3E4` | fundo de aviso de erro |
| `--qb-scrim` | `rgba(0,0,0,.46)` | fundo atrás de modal e diálogo |

Duas regras que dão a cara do produto e são fáceis de perder:

- **Nada é branco puro.** `#FFFFFF` num fundo é sempre um deslize; o certo é `--qb-canvas`.
- **Os cinzas são neutros** (`#707070`), não os azulados do iOS (`#8E8E93`). O azul também não
  é o `#007AFF` do sistema.

Ficam de fora do sistema, de propósito: as cores dos mascotes (`appearance.ts`, `bursts.ts`),
o verde e o laranja de estado, e os gradientes das telas de entrada. São conteúdo e marca,
não cromo.

## Curvatura

Cinco degraus, nada entre eles:

| Token | Valor | Onde |
| --- | --- | --- |
| `--qb-r-xs` | 6px | etiqueta de cargo, segmento ativo |
| `--qb-r-sm` | 8px | botão, campo, quadrado de ícone |
| `--qb-r-md` | 10px | cartão, menu, popover |
| `--qb-r-lg` | 14px | bolha de conversa |
| `--qb-r-xl` | 20px | modal |

## Letra

| Token | Valor | Onde |
| --- | --- | --- |
| `--qb-t-xs` | 12px | rótulo de campo, cabeçalho de seção, hora |
| `--qb-t-sm` | 13px | descrição, texto de apoio |
| `--qb-t-md` | 14px | item de menu, corpo de formulário |
| `--qb-t-lg` | 15px | conversa, nome na lista, valor de campo |
| `--qb-t-title` | 22px | título de modal grande |

## Medidas

- Lista de bots: **316px**, com fio de 1px à direita.
- Cabeçalho: **44px**.
- Botão: **32px** de altura (26px na variante de linha).
- Campo: **32px** de altura.
- Prévia da tela do bot: 16:10, com a legenda em `--qb-muted` abaixo.

## Padrões

- **Diálogo destrutivo** — título nomeando o alvo entre aspas, corpo dizendo que é permanente,
  botões à direita: cancelar em `--qb-surface-2`, confirmar em `--qb-danger`.
- **Menu** — grupos separados por fio, ícone de 16 à esquerda, item destrutivo inteiro em
  `--qb-danger`.
- **Modal** — uma superfície só (`.qb-modal`), sobre `--qb-scrim`, com o mesmo cabeçalho.
- **Erro** — fundo `--qb-danger-soft`, borda mais saturada, ação primária no canto inferior.

## Dívida conhecida

O app Expo (`apps/mobile`) usa estes tokens desde o redesenho do mobile: `COLORS` em
`apps/mobile/lib/design-system.tsx` é montado a partir de `tokens`, e o app roda claro do
login à conversa (`userInterfaceStyle: "light"` no `app.json`). A única superfície escura
que sobrou é a prévia da tela do bot em `apps/mobile/app/computer.tsx` — ela é a máquina de
verdade, não cromo do app, e por isso tem três tons próprios e nomeados (`SCREEN_BLACK`,
`SCREEN_INK`, `SCREEN_MUTED`). A câmera do leitor de QR também é escura, pela mesma razão.

As cores dos mascotes seguem de fora do sistema, como no web: o preto do Grok em
`character-picker.tsx` e o dourado do chief of staff na lista são conteúdo, não cromo.

Os 31 seletores do tipo `[class*="bg-[#1C1C1E]"]`, que repintavam classes escuras deixadas no
JSX, não existem mais: as telas de onboarding, plugins, conta, cobrança e máquina passaram a
usar os tokens direto. Enquanto eles existiram, qualquer classe escura nova nascia certa por
acaso — e uma que ficasse de fora da lista, como o `hover:bg-[#161618]` da lista de
provedores, aparecia como uma barra preta sobre texto escuro.

