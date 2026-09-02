# Casa portátil do bot — checkpoint em `DATA_DIR`

O disco do Docker, da Box, da E2B ou da Daytona é cache. A fonte da verdade do
trabalho de cada bot é um snapshot no volume do Quibt (`DATA_DIR`), um por
`botId`. Trocar de máquina não apaga os arquivos nem os logins gravados no
Chromium daquele bot.

## O que entra no snapshot

- A casa portátil do provedor (`/home/quibt` no Docker, `/home/user` na E2B,
  `/home/ubuntu` na Box, `/home/daytona` na Daytona).
- O diretório de perfil do Chromium daquele bot (`/quibt-desktops/<bot>/chrome`
  no Docker; `~/.config/chromium` nos outros).

Não entra a tela: nem o display X11, nem a sessão noVNC, nem as janelas que
estavam abertas. Também não entram caches (`Cache`, `Code Cache`, `GPUCache`,
`/tmp`, `node_modules`, `.npm/_cacache`, lixeira).

## Quando o Quibt grava e restaura

Grava no fim de uma corrida, no stop explícito, no sono por ociosidade e
antes de destruir o sandbox. Restaura ao criar ou hidratar um computador —
provedor novo, sandbox id sumido, ou volta depois de arquivo — **antes** do
primeiro comando da pessoa.

O mesmo `botId` lê o mesmo snapshot. Outro bot não compartilha.

No Docker / VPS a casa `/home/quibt` é do escritório (vários bots). O snapshot
ainda leva uma cópia daquela casa — útil ao ir para E2B, Box ou Daytona — mas
a restauração **nesse** computador só escreve o perfil Chromium daquele bot.
Assim um colega no mesmo container não perde os arquivos dele.

## Criptografia

O blob em `DATA_DIR/workspace-checkpoints/<botId>/snapshot.qbhc` usa a mesma
`ENCRYPTION_KEY` que já protege as outras chaves do bot (AES-256-GCM). Sem
snapshot (bot recém-criado) a restauração é no-op.

## Limite honesto

Janelas de GUI não teleportam. Logins que o Chromium gravou no perfil, sim.
Uma troca Docker → Box → E2B → Daytona traz os arquivos e os cookies; a mesa
nasce limpa no provedor novo.

O código vive em `packages/adapters/src/workspace-checkpoint.ts`. Os
emuladores (`fake`, `e2b-emulator`, `box-emulator`, `daytona-emulator`) usam
o mesmo helper, então os testes não pedem chave de vendor.
