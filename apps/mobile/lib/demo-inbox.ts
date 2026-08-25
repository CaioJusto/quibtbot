import type { MobileBot, MobileMessage } from "./api";

const DEMO_PREFIX = "demo:";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Screenshot-only inbox data. It is added only by development builds, never by
 * the API and never by a production bundle.
 */
export const DEMO_BOTS: MobileBot[] = [
  {
    id: `${DEMO_PREFIX}maia`,
    name: "Maia",
    title: "E-mail",
    preview: "Separei os e-mails urgentes e deixei três respostas prontas.",
    color: "#5B7FE5",
    shape: "strobi",
    status: "idle",
    updatedAt: minutesAgo(4),
  },
  {
    id: `${DEMO_PREFIX}atlas`,
    name: "Atlas",
    title: "Pesquisa",
    preview: "Comparei os fornecedores e montei um resumo com preços e riscos.",
    color: "#FFCF24",
    shape: "citrus",
    status: "running",
    unread: true,
    updatedAt: minutesAgo(12),
  },
  {
    id: `${DEMO_PREFIX}luma`,
    name: "Luma",
    title: "Conteúdo",
    preview: "O calendário da semana está pronto para sua aprovação.",
    color: "#FFC2E9",
    shape: "kirby",
    status: "idle",
    updatedAt: minutesAgo(31),
  },
  {
    id: `${DEMO_PREFIX}nilo`,
    name: "Nilo",
    title: "Operações",
    preview: "Acompanhei os pedidos atrasados e cobrei os responsáveis.",
    color: "#55B6C3",
    shape: "nova",
    status: "idle",
    updatedAt: minutesAgo(76),
  },
  {
    id: `${DEMO_PREFIX}bento`,
    name: "Bento",
    title: "Agenda",
    preview: "Reorganizei sua tarde e confirmei as duas reuniões prioritárias.",
    color: "#E6855C",
    shape: "freddy",
    status: "idle",
    updatedAt: minutesAgo(138),
  },
];

export type DemoBotSettings = Partial<MobileBot> & {
  instructions?: string;
  notifyOnFinish?: boolean;
};

export function demoBotForId(
  botId: string | undefined,
  overrides: Record<string, DemoBotSettings> = {},
): MobileBot {
  const bot = DEMO_BOTS.find((candidate) => candidate.id === botId) ?? DEMO_BOTS[0]!;
  return { ...bot, ...(overrides[bot.id] ?? {}) };
}

export function defaultDemoInstructions(botId: string | undefined): string {
  const bot = demoBotForId(botId);
  const instructions: Record<string, string> = {
    [`${DEMO_PREFIX}maia`]:
      "Organize minha caixa de entrada, destaque o que exige atenção e prepare respostas objetivas para eu aprovar.",
    [`${DEMO_PREFIX}atlas`]:
      "Pesquise fontes confiáveis, compare alternativas e entregue uma recomendação clara com riscos e próximos passos.",
    [`${DEMO_PREFIX}luma`]:
      "Planeje e escreva conteúdos com linguagem humana, mantendo consistência de voz e pedindo aprovação antes de publicar.",
    [`${DEMO_PREFIX}nilo`]:
      "Acompanhe operações, identifique gargalos, cobre responsáveis e me avise quando uma decisão minha for necessária.",
    [`${DEMO_PREFIX}bento`]:
      "Organize compromissos, resolva conflitos de agenda e confirme alterações importantes antes de enviá-las.",
  };
  return instructions[bot.id] ?? "Ajude a organizar o trabalho e volte com uma resposta clara.";
}

export function isDemoBotId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(DEMO_PREFIX));
}

/**
 * Screenshot data is opt-in: a dev bundle alone is not enough. Rodar o app de
 * verdade contra o próprio servidor mostrava bots que não existem em lugar nenhum,
 * e eles não aceitam anexo, áudio nem computador — parecia bot quebrado, não demo.
 * Ligue com `EXPO_PUBLIC_DEMO_INBOX=1` quando for tirar print.
 */
export function developmentInboxEnabled(): boolean {
  if (typeof __DEV__ === "undefined" || !__DEV__) return false;
  return process.env.EXPO_PUBLIC_DEMO_INBOX === "1";
}

export function withInboxPlaceholders(
  bots: MobileBot[],
  enabled = developmentInboxEnabled(),
  minimum = 5,
): MobileBot[] {
  if (!enabled || bots.length >= minimum) return bots;
  const used = new Set(bots.map((bot) => bot.id));
  const additions = DEMO_BOTS.filter((bot) => !used.has(bot.id)).slice(0, minimum - bots.length);
  return [...bots, ...additions];
}

export function demoMessagesForBot(botId: string | undefined): MobileMessage[] {
  const bot = DEMO_BOTS.find((candidate) => candidate.id === botId) ?? DEMO_BOTS[0]!;
  const conversation = DEMO_CONVERSATIONS[bot.id] ?? [
    "Veja o que precisa da minha atenção hoje.",
    bot.preview,
  ];
  return [
    demoMessage(`${bot.id}:user`, "user", conversation[0]!, minutesAgo(8)),
    demoMessage(`${bot.id}:bot`, "bot", conversation[1]!, minutesAgo(6)),
  ];
}

export function demoReplyForBot(botId: string | undefined): string {
  const bot = DEMO_BOTS.find((candidate) => candidate.id === botId) ?? DEMO_BOTS[0]!;
  return `Pode deixar. Eu, ${bot.name}, vou cuidar disso e volto com tudo organizado.`;
}

const DEMO_CONVERSATIONS: Record<string, [string, string]> = {
  [`${DEMO_PREFIX}maia`]: [
    "Revise minha caixa de entrada e prepare as respostas mais importantes.",
    "Pronto. Separei 7 mensagens prioritárias, arquivei o ruído e deixei três respostas prontas para você revisar.",
  ],
  [`${DEMO_PREFIX}atlas`]: [
    "Compare os fornecedores para o projeto novo.",
    "Comparei preço, prazo, suporte e risco. A melhor relação custo-benefício ficou com a segunda opção; deixei o resumo executivo pronto.",
  ],
  [`${DEMO_PREFIX}luma`]: [
    "Organize o conteúdo da próxima semana.",
    "Montei cinco publicações, distribuí os temas durante a semana e deixei cada legenda em rascunho para sua aprovação.",
  ],
  [`${DEMO_PREFIX}nilo`]: [
    "Veja por que os pedidos estão atrasados.",
    "Encontrei quatro gargalos, cobrei os responsáveis e organizei um acompanhamento diário até normalizar a operação.",
  ],
  [`${DEMO_PREFIX}bento`]: [
    "Arrume minha agenda de hoje.",
    "Reorganizei sua tarde, eliminei dois conflitos e confirmei as reuniões prioritárias com todos os participantes.",
  ],
};

function demoMessage(
  id: string,
  role: MobileMessage["role"],
  text: string,
  createdAt: string,
): MobileMessage {
  return { id, role, blocks: [{ kind: "text", text }], createdAt };
}
