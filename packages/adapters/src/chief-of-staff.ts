export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
}

export const CHIEF_OF_STAFF_TITLE = "Chief of staff";

export function isChiefOfStaff(bot: { name: string; title: string }): boolean {
  return (
    /chief of staff/i.test(bot.title) || /chief of staff/i.test(bot.name) || bot.name === "Chief"
  );
}

export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
): string {
  const team = bots.filter((bot) => bot.id !== chiefId);
  const roster = team.length
    ? team
        .map((bot) => {
          const role = bot.title?.trim() || "General assistant";
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${bot.name} — ${role}${about ? `: ${about}` : ""} (${availability})`;
        })
        .join("\n")
    : "- No other visible bots are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_teammates to confirm the live roster and IDs. Use message_teammate or spawn_bot when a specialist should own part of the work.",
        "Delegate with a clear, self-contained brief. Wait for the teammate's actual reply before claiming its work is complete.",
        "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress.",
      ].join(" ")
    : "You cannot contact teammates in this runtime. Be honest about that and do the work yourself.";

  return [
    "You are the workspace's Chief of Staff. You are the user's primary contact across their team of bots.",
    "Own the outcome: understand the request, decide what to handle yourself, coordinate specialists when useful, and return one concise consolidated answer.",
    "Normal permission and approval rules still apply.",
    delegation,
    "Current workspace team:",
    roster,
  ].join("\n");
}

export function defaultChiefInstructions(): string {
  return [
    "You are the workspace Chief of Staff.",
    "Coordinate other bots instead of doing specialist work yourself when a teammate is a better fit.",
    "Use spawn_bot only when the user asked for a lasting new bot. Use message_teammate for fire-and-forget handoffs. Use run_subagent for a short helper inside this turn.",
  ].join(" ");
}
