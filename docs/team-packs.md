# Pacotes de equipe (arquivo Markdown)

Um **pacote de equipe** é um arquivo Markdown que o Quibt transforma num time inteiro:
bots com instruções, um grupo com ordens permanentes e rotinas sugeridas. Serve para
compartilhar um time pronto ("meu setup de estúdio de conteúdo") sem mandar prints nem
passo a passo.

Para importar: na lista de conversas, **+ → Importar equipe (.md)** — ou ⌘K e
"Importar equipe". Dá para escolher o arquivo ou colar o texto; o Quibt mostra o que vai
nascer antes de criar qualquer coisa.

## O formato

```markdown
# Equipe: Growth

> Falem sempre em português.
> Nada é publicado sem aprovação humana.

## Ana — Analista de Dados

Você cuida dos números da empresa. Responda com tabelas
sempre que possível e cite a fonte de cada número.

### Rotina: Relatório diário
- Agenda: todo dia às 9h
- Fuso: America/Sao_Paulo

Monte o resumo de ontem (vendas, tráfego, cadastros) e mande no grupo.

## Beto — Redator

Você escreve os textos. Tom direto, sem jargão.
```

As regras, em uma linha cada:

| Elemento | Como escrever |
| --- | --- |
| Equipe | `# Equipe: Nome` (ou `# Team: Nome`) — opcional; sem ele, os bots nascem avulsos, sem grupo |
| Ordens do grupo | Qualquer texto entre o título da equipe e o primeiro bot (o `>` de citação é opcional) |
| Bot | `## Nome — Cargo` — o cargo é opcional (`## Nome` também vale) |
| Instruções do bot | Todo o Markdown da seção do bot, até a próxima seção |
| Rotina | `### Rotina: Nome` dentro da seção do bot (ou `### Routine:`) |
| Agenda da rotina | `- Agenda: todo dia às 9h` — frase simples ou um cron de 5 campos (`0 9 * * *`) |
| Fuso da rotina | `- Fuso: America/Sao_Paulo` — opcional; sem ele, UTC |
| Prompt da rotina | Os parágrafos da seção da rotina, depois da lista |

Limites por importação: 20 bots, 10 rotinas por bot, e os mesmos tetos de tamanho dos
formulários do app (nome 80, cargo 160, instruções e prompts 20.000 caracteres).

## O que um pacote nunca carrega

- **Credenciais.** O formato não tem campo de chave, e um arquivo que traga algo com
  cara de segredo (uma chave `sk-…`, um token, um campo `senha:` preenchido) é recusado
  inteiro. Chaves são coladas nos ajustes, depois de importar.
- **Conectores ligados.** Plugins e conexões (Gmail, Notion…) não vêm no pacote; quem
  importou conecta e autoriza cada um na própria conta.
- **Rotinas ativas.** Toda rotina importada chega **pausada**. Revise o prompt e a
  agenda e ligue uma a uma, nos ajustes do bot ou do grupo.

## O que acontece ao importar

1. Cada `##` vira um bot novo (com computador, memória e conversa próprios, como um bot
   criado à mão).
2. Havendo `# Equipe:` e pelo menos um bot criado, nasce um grupo com esses bots e as
   ordens permanentes do preâmbulo.
3. Cada `### Rotina:` vira uma rotina pausada do bot dono da seção.
4. Se algo falhar no meio (limite do plano, por exemplo), o que já nasceu fica, e o
   painel lista exatamente o que faltou.

A importação usa os mesmos endpoints das telas de criar bot, grupo e rotina — um pacote
não faz nada que você não conseguiria fazer clicando.
