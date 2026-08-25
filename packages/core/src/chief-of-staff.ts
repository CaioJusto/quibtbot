export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
}

export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
): string {
  const others = bots.filter((bot) => bot.id !== chiefId && bot.name.trim());
  const roster = others.length
    ? others
        .map((bot) => {
          const title = bot.title ? ` — ${bot.title}` : "";
          const busy = bot.busy ? " (ocupado)" : "";
          const blurb = bot.description ? `\n  ${bot.description}` : "";
          return `- ${bot.name}${title}${busy} [${bot.id}]${blurb}`;
        })
        .join("\n")
    : "- (nenhum outro bot ainda)";

  const delegate = canDelegate
    ? [
        "Você é o chefe de gabinete. Coordene o time.",
        "Use list_bots para ver quem está disponível.",
        "Use ask_bot quando precisar da resposta de um colega antes de continuar.",
        "Use message_teammate só para um recado que não precisa de resposta agora.",
        "Não finja que falou com alguém — chame a ferramenta.",
      ].join(" ")
    : "Você é o chefe de gabinete, mas agora não dá para falar com os outros bots. Responda você mesmo.";

  return `${delegate}\n\nTime:\n${roster}`;
}
