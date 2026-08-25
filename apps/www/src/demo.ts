export type DemoCardLine = {
  k: string;
  v: string;
};

export type DemoMessage =
  | { type: "time"; text: string }
  | { type: "meta"; text: string }
  | { type: "user"; text: string }
  | { type: "bot"; text: string }
  | { type: "typing" }
  | { type: "card"; lines: DemoCardLine[] };

export type DemoRoutine = {
  name: string;
  when: string;
  instruction?: string;
};

export type DemoScreen = {
  host: string;
  title: string;
  lines: string[];
};

export type DemoBot = {
  id: string;
  name: string;
  color: string;
  shape?: string;
  time: string;
  preview: string;
  routines: DemoRoutine[];
  screen: DemoScreen;
  thread: DemoMessage[];
  reply: string;
};

export type RosterBot = {
  name: string;
  color: string;
  shape?: string;
  slug: string;
  desc: string;
};

export const DEMO_BOTS: DemoBot[] = [
  {
    id: "chief",
    name: "Lume",
    color: "#DBE2F5",
    shape: "onee",
    time: "Ontem",
    preview: "estúdio reservado, plano de lançamento pronto",
    routines: [{ name: "Pulso do lançamento", when: "Terças 8h" }],
    screen: {
      host: "linear.app",
      title: "Lançamento Aurora — central",
      lines: ["Orbit Loft confirmado", "18 pessoas na lista", "Roteiro pronto"],
    },
    thread: [
      { type: "time", text: "Ontem 10:18" },
      {
        type: "user",
        text: "monta um café pequeno para o lançamento da Aurora",
      },
      {
        type: "bot",
        text: "mapeei a lista, três espaços e um roteiro de duas horas. seguro a melhor opção antes de qualquer pagamento.",
      },
      {
        type: "card",
        lines: [
          { k: "Reservado", v: "Orbit Loft · 18 set" },
          { k: "Orçamento", v: "R$ 6.900 de R$ 8 mil" },
          { k: "Pendente", v: "restrições de 3 convidados" },
        ],
      },
      {
        type: "user",
        text: "fica com o Orbit Loft e separa quinze minutos para a demo",
      },
      {
        type: "bot",
        text: "feito. o espaço está seguro, a demo entrou no roteiro e os convites estão prontos para você revisar.",
      },
    ],
    reply:
      "adicionei. atualizo a contagem e mantenho o painel do lançamento em dia.",
  },
  {
    id: "sales",
    name: "Prisma",
    color: "#5B7FE5",
    shape: "strobi",
    time: "03:26",
    preview: "28 climate techs mapeadas, 12 resumos prontos",
    routines: [
      { name: "Mapa de sinais", when: "Toda noite 1h" },
      { name: "Pulso dos founders", when: "Dias úteis 8h" },
    ],
    screen: {
      host: "airtable.com",
      title: "Climate ops — mapa de sinais",
      lines: ["28 times mapeados", "16 sinais recentes", "12 resumos prontos"],
    },
    thread: [
      { type: "time", text: "Ontem 21:35" },
      {
        type: "user",
        text: "acha times de software climático chegando na América Latina e faz um resumo curto de cada um",
      },
      {
        type: "bot",
        text: "vou cruzar lançamentos, vagas e entrevistas dos founders. ninguém recebe contato; você ganha um painel enxuto para revisar.",
      },
      { type: "meta", text: "Rotina criada ◷ Mapa de sinais" },
      { type: "time", text: "03:26" },
      {
        type: "card",
        lines: [
          { k: "Mapeados", v: "28 times · 16 com sinal recente" },
          { k: "Resumidos", v: "12 lançamentos" },
          { k: "Separados", v: "5 · fora da região-alvo" },
        ],
      },
      {
        type: "bot",
        text: "três times abriram vagas no Brasil neste mês. coloquei esses no topo e deixei cada fonte ao lado da nota.",
      },
    ],
    reply:
      "tô nisso. adiciono os sinais novos e mantenho as fontes junto de cada resumo.",
  },
  {
    id: "inbox",
    name: "Velo",
    color: "#E65C5C",
    shape: "cubee",
    time: "00:24",
    preview: "caixa tranquila, 4 respostas prontas",
    routines: [
      { name: "Ordem ao amanhecer", when: "Dias úteis 6:30" },
      { name: "Pulso de prioridade", when: "A cada 90 min" },
    ],
    screen: {
      host: "mail.google.com",
      title: "Velo — 4 respostas prontas",
      lines: [
        "34 conversas organizadas",
        "17 agrupadas · 8 respondidas",
        "Pedido de logo da Solara em revisão",
      ],
    },
    thread: [
      { type: "time", text: "Ontem 22:48" },
      {
        type: "user",
        text: "limpa a caixa, mas deixa tudo do lançamento por perto",
      },
      {
        type: "bot",
        text: "fechado. agrupo recibos e atualizações, respondo a logística simples e puxo cada conversa da Aurora para uma pilha só.",
      },
      { type: "time", text: "00:24" },
      {
        type: "card",
        lines: [
          { k: "Agrupados", v: "17 atualizações + recibos" },
          { k: "Respondidos", v: "8 ajustes de agenda" },
          { k: "Rascunhados", v: "4 respostas de parceiros" },
          { k: "Fixado", v: "1 da Bia, da Solara · dúvida de logo" },
        ],
      },
      {
        type: "bot",
        text: "a Bia quer colocar a marca Aurora na página do lançamento. deixei a aprovação pronta com o link do brand kit atual e fixei no topo.",
      },
      {
        type: "user",
        text: "manda esse e guarda os outros rascunhos para de manhã",
      },
      {
        type: "bot",
        text: "enviado. a caixa ficou tranquila e quatro rascunhos esperam sua passada de manhã.",
      },
    ],
    reply:
      "feito. encaixo isso na próxima passada e fixo qualquer ponto que precise da sua decisão.",
  },
  {
    id: "account",
    name: "Nexo",
    color: "#55B6C3",
    shape: "nova",
    time: "Ontem",
    preview: "resumo da Marea atualizado, Lia convidada",
    routines: [{ name: "Bússola de contas", when: "Todo dia 9h" }],
    screen: {
      host: "attio.com",
      title: "Marea Foods — piloto em lojas",
      lines: ["Terça 15:30 com Lia", "Piloto cobre 3 lojas", "Mateo aprova"],
    },
    thread: [
      { type: "time", text: "Ontem 15:06" },
      {
        type: "bot",
        text: "a Marea perguntou se o piloto pode começar em três lojas em vez de uma. puxei as decisões da última conversa.",
      },
      { type: "meta", text: "Memória atualizada · Marea Foods" },
      {
        type: "bot",
        text: "guardei para a próxima: Mateo aprova o escopo e Lia é dona do calendário de implantação.",
      },
      {
        type: "user",
        text: "marca uma revisão curta do piloto com a Lia na terça à tarde",
      },
      {
        type: "bot",
        text: "Lia recebeu terça às 15:30, com a proposta para três lojas e as notas da última conversa.",
      },
    ],
    reply:
      "salvei. mantenho o resumo da conta e os donos de decisão sincronizados.",
  },
  {
    id: "talent",
    name: "Mosaico",
    color: "#C9CBCF",
    shape: "cloudee",
    time: "Ontem",
    preview: "8 líderes de suporte na lista, 3 notas prontas",
    routines: [{ name: "Janela de portfólios", when: "Ter + Qui" }],
    screen: {
      host: "ashbyhq.com",
      title: "Liderança de suporte — seleção",
      lines: [
        "52 perfis revisados",
        "8 refizeram um processo de QA",
        "3 notas pessoais prontas",
      ],
    },
    thread: [
      { type: "time", text: "Ontem 17:12" },
      {
        type: "user",
        text: "procura líderes de suporte que refizeram a revisão de qualidade enquanto o time crescia",
      },
      {
        type: "card",
        lines: [
          { k: "Revisados", v: "52 perfis" },
          { k: "Selecionados", v: "8 · redesenho prático de QA" },
          { k: "Preparadas", v: "3 notas de apresentação" },
        ],
      },
      {
        type: "bot",
        text: "os três primeiros documentaram o processo que criaram, não só o resultado. liguei esses exemplos a cada nota.",
      },
    ],
    reply:
      "comparo os novos perfis com essa barra e preparo só as notas mais fortes.",
  },
  {
    id: "expense",
    name: "Cifra",
    color: "#E69A5C",
    shape: "sunee",
    time: "Ontem",
    preview: "workshop fechado, 11 recibos conciliados",
    routines: [{ name: "Fechamento do workshop", when: "Última sexta" }],
    screen: {
      host: "app.ramp.com",
      title: "Workshop de design — fechamento",
      lines: [
        "11 recibos conciliados",
        "Dois passes de estúdio verificados",
        "Relatório pronto · R$ 3.180",
      ],
    },
    thread: [
      { type: "time", text: "Ontem 09:14" },
      {
        type: "user",
        text: "fecha as despesas do workshop de design antes do almoço",
      },
      {
        type: "bot",
        text: "vou ligar cada cobrança ao recibo, separar por dia de workshop e parar no que tiver duas leituras.",
      },
      { type: "meta", text: "Rotina criada ◷ Fechamento do workshop" },
      { type: "time", text: "Ontem 11:42" },
      {
        type: "card",
        lines: [
          { k: "Conciliados", v: "11 recibos" },
          { k: "Total", v: "R$ 3.180 em 2 dias" },
          { k: "Verificados", v: "2 passes do Atelier Norte" },
        ],
      },
      {
        type: "bot",
        text: "o Atelier Norte cobrou um passe em cada dia. os dois batem com a lista de presença, então não há duplicidade.",
      },
      { type: "user", text: "ótimo, anexa a lista de presença e fecha" },
      {
        type: "bot",
        text: "fechado. relatório, recibos e lista de presença estão juntos na pasta do workshop.",
      },
    ],
    reply: "registrei. mantenho isso junto do próximo fechamento de workshop.",
  },
  {
    id: "bugs",
    name: "Faísca",
    color: "#FFC2E9",
    shape: "kirby",
    time: "Segunda",
    preview: "falha do CSV isolada, fixture anexada",
    routines: [{ name: "Varredura de sinais", when: "A cada 2h" }],
    screen: {
      host: "sentry.io",
      title: "Exportação CSV — nomes com acento",
      lines: [
        "7 relatos agrupados",
        "3 ambientes reproduzidos",
        "Locale do Windows isolado",
      ],
    },
    thread: [
      { type: "time", text: "Segunda 08:44" },
      {
        type: "user",
        text: "descobre por que alguns nomes exportados perdem os acentos",
      },
      {
        type: "card",
        lines: [
          { k: "Agrupados", v: "7 relatos · uma assinatura" },
          { k: "Reproduzidos", v: "3 locales do Windows" },
          { k: "Isolado", v: "caminho legado de encoding" },
        ],
      },
      {
        type: "bot",
        text: "o exportador alternativo usa a página de código do sistema no Windows. anexei uma fixture que falha e a menor reprodução.",
      },
    ],
    reply:
      "testo o caso novo, anexo a evidência e atualizo a issue com o resultado.",
  },
];

export const DEMO_ROSTER: RosterBot[] = [
  {
    name: "Kibo",
    color: "#111316",
    shape: "grok",
    slug: "quibt/kibo",
    desc: "Transforma pedidos soltos em um plano diário claro e separa o que ainda precisa da sua decisão.",
  },
  {
    name: "Meli",
    color: "#E6855C",
    shape: "freddy",
    slug: "quibt/meli",
    desc: "Cruza sinais, organiza as fontes e entrega resumos curtos para você escolher o próximo passo.",
  },
  {
    name: "Zazu",
    color: "#55B6C3",
    shape: "nova",
    slug: "quibt/zazu",
    desc: "Mantém relações aquecidas, lembra o contexto e prepara a próxima conversa.",
  },
  {
    name: "Tuca",
    color: "#E69A5C",
    shape: "sunee",
    slug: "quibt/tuca",
    desc: "Fecha pontas entre ferramentas, agenda retornos e documenta o que mudou.",
  },
  {
    name: "Prisma",
    color: "#5B7FE5",
    shape: "strobi",
    slug: "quibt/prisma",
    desc: "Mapeia sinais em fontes abertas, conecta evidências e prepara um painel para revisão.",
  },
  {
    name: "Velo",
    color: "#E65C5C",
    shape: "cubee",
    slug: "quibt/velo",
    desc: "Agrupa o ruído, resolve a logística simples e fixa o que exige julgamento humano.",
  },
  {
    name: "Mosaico",
    color: "#C9CBCF",
    shape: "cloudee",
    slug: "quibt/mosaico",
    desc: "Compara perfis ao seu critério e conecta cada recomendação à evidência certa.",
  },
  {
    name: "Lume",
    color: "#DBE2F5",
    shape: "onee",
    slug: "quibt/lume",
    desc: "Orquestra lançamentos, reuniões e handoffs sem perder datas, donos ou pendências.",
  },
  {
    name: "Faísca",
    color: "#FFC2E9",
    shape: "kirby",
    slug: "quibt/faisca",
    desc: "Agrupa relatos, reproduz o defeito e entrega evidência pequena o bastante para virar correção.",
  },
  {
    name: "Cifra",
    color: "#FFCF24",
    shape: "citrus",
    slug: "quibt/cifra",
    desc: "Concilia despesas, confirma ambiguidades e fecha cada evento com a documentação no lugar.",
  },
];
