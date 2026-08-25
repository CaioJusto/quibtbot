# Entrar no Quibt: e-mail e senha ainda fazem sentido?

Resposta curta: **para o produto local-first, não.** O e-mail hoje não entrega nada
(a instalação não manda e-mail), e a senha é o único jeito de entrar que não usa o
que já provamos — que a pessoa está com a máquina onde o Quibt roda. Este documento
descreve o que existe hoje, o que quebra, e o desenho de um modelo "só código".

## O que existe hoje

| Fluxo | Precisa de senha? | Como prova quem é |
| --- | --- | --- |
| Primeiro dono (instalação nova) | **Sim**, no cadastro | Código de 8 caracteres impresso pelo instalador (`/api/bootstrap/claim`), válido 10 min, hash em repouso |
| Segundo aparelho (celular) | Não | QR com `oneTimeToken` de 2 min gerado pelo dono já logado (Conta → Celular) |
| Entrar no navegador | Sim | E-mail + senha (better-auth) |
| Esqueci a senha, **com** mailer | Não | Link por e-mail |
| Esqueci a senha, **sem** mailer | — | `/api/local/reset-link`, só de `127.0.0.1`: exige estar no teclado da máquina |

Ou seja: nos dois caminhos que realmente importam para instalar e usar (instalador e
celular), a pessoa **já provou controle físico** — e mesmo assim tem que inventar uma
senha. Do outro lado, quem perde a senha num deploy em VPS não tem recuperação nenhuma
pela rede: precisa de SSH até a máquina para abrir o link de loopback.

## Por que o e-mail hoje é decoração

- `BILLING_ENABLED=false` é o padrão público, e `emailVerified` só é exigido no checkout
  do Stripe. Nada mais no produto lê esse campo.
- Sem `RESEND_API_KEY`, `sendVerificationEmail` e `sendChangeEmailConfirmation` viram
  no-op. Até esta correção, a tela de Conta dizia "Enviamos o e-mail de verificação"
  mesmo sem mailer — agora ela diz a verdade e desabilita a troca de e-mail.
- O e-mail continua útil como **identificador legível** ("quem é este dono?") e como
  gancho para quem *tem* mailer. Ele não precisa deixar de existir; precisa deixar de
  ser obrigatório e de ser o caminho de recuperação.

## Modelo proposto: só código

Uma ideia, três regras:

1. **Quem instala é o dono.** O instalador já imprime um código; ele cria a conta sem
   pedir senha. Nome, sim; e-mail, opcional.
2. **Entrar em um aparelho novo = código curto** gerado por um aparelho já logado
   (é o que o QR do celular já faz, generalizado para "mostrar 6 dígitos" quando não
   dá para ler QR — por exemplo, digitar no navegador de outro computador).
3. **Perdeu todos os aparelhos** = voltar ao terminal da máquina: um comando
   (`quibtbot pair`) imprime um código novo, com o mesmo desenho de segurança do
   bootstrap. É o equivalente honesto de "recuperação", já que a instalação é sua.

O que muda no código, em ordem de risco:

| Passo | Onde | Risco |
| --- | --- | --- |
| Senha opcional no cadastro quando há `x-quibt-enrollment` (o código já provou o controle) | `apps/api/src/app.ts` (sign-up), telas de cadastro web/mobile | baixo |
| `POST /api/pairing/code` (dono logado emite código de 6–8 dígitos, TTL curto, hash em repouso, rate limit por IP e por código) e `POST /api/pairing/claim` (troca por sessão) | reaproveita `packages/core/src/bootstrap-invite.ts` e `checkPersistentBootstrapRateLimit` | médio |
| Tela "Entrar com código" no web e no celular, ao lado de e-mail/senha | `apps/web/src/pages/Auth.tsx`, `apps/mobile/app/sign-in.tsx` | baixo |
| `quibtbot pair` no CLI, para quem perdeu tudo | `apps/cli` | baixo |
| Definir senha depois (opcional) sem saber a atual, exigindo sessão recém-pareada | better-auth `setPassword` | médio |

Cuidados que não podem ser esquecidos:

- **Código curto exige limite duro de tentativas.** O bootstrap já usa contador
  persistente em Postgres; o pareamento recorrente precisa dos seus próprios números
  (por código, por IP e global), senão 6 dígitos numa VPS pública são adivinháveis.
- **Só o dono emite código.** Enquanto o produto é de um dono por instalação, o código
  cria sessão para o mesmo usuário — nunca um segundo membro.
- **Manter e-mail+senha como opção**, para quem roda com mailer e quer o login clássico.
  A mudança é tirar a obrigatoriedade, não remover o recurso.

## O que já está feito

| Antes | Agora |
| --- | --- |
| Primeira conta pedia nome, e-mail e senha | Pede só o nome; o servidor inventa e-mail (`@quibt.invalid`, domínio reservado que nunca resolve) e senha aleatória que ninguém precisa saber |
| Entrar em outro aparelho: QR (2 min) ou senha | QR **ou** código de 8 caracteres digitável, emitido por um aparelho já conectado |
| Conta prometia e-mails que a instalação não envia | Sem mailer, "Reenviar verificação" some e trocar o e-mail fica desabilitado, com o motivo à vista |

Como pedir o código: no computador, **Conta → Celular → Liberar entrada** mostra o
QR e, embaixo, o código. No celular: **Entrar com código**.

Regras do código (`packages/core/src/device-code.ts`): cinco minutos de vida, uso
único, seis tentativas antes de queimar, um por conta (emitir de novo invalida o
anterior) e só o SHA-256 fica no banco. A rota de resgate ainda passa pelo limite
por IP que o bootstrap já usava.

## O que falta

- **Perdi todos os aparelhos.** A recuperação continua exigindo o terminal da máquina:
  `quibtbot pair` emite um convite novo de uso único; não há recuperação remota sem prova de
  controle do servidor.
- **Login clássico.** E-mail e senha continuam existindo para quem roda com mailer;
  o que mudou é que deixaram de ser obrigatórios.
- **Segundo humano.** O código cria sessão para o mesmo dono, nunca um segundo
  membro. Convidar outra pessoa continua fora do escopo.

## Estado desta análise

Implementado nas três frentes (API, web, celular) e coberto por teste de
integração contra Postgres (`apps/api/src/pairing-code.test.ts`).
