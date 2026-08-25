# Chat do Grok 0.18 no Quibt — só cromo visual

Referência somente-leitura da reconstrução 0.18. Este slice **não porta
funções novas**. Só alinha densidade do app aberto e do chat às medidas do
Grok, nos tokens claros do Quibt.

O overlay de configurações e o porto do computador foram revertidos a
`origin/main`. O Quibt continua com as configurações e o monitor que já tinha.

## O que o CSS muda

- Sidebar: busca que já existia; linhas ~58px; avatar/iniciais 34px. Sem
  bonecos, sem colapso novo.
- Header: ~51px sobre o `qb-dash__topbar` existente. Toggle do computador
  permanece o que já estava.
- Bolhas: raio 18px, padding 8×12, largura até 640. Markdown e aprovações
  não mudam.
- Composer: casca 16px, + / mic / enviar 30px. Fila, menção, voz, anexos e
  “Ensinar uma tarefa” são os que o Quibt já tinha.

## O que não entra

Roteador/Uso, paleta, busca no fio, faixa de reconexão, overlay/capa do
computador, persistência de rascunho, rebuild.

Cores: somente `--qb-*`. Canvas `#FCFCFC`. PT-BR. Sem tema escuro.

## Screenshots

- `docs/assets/quibt-app-open.png`
- `docs/assets/quibt-chat-open.png`
