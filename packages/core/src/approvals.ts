import { sha256 } from "./secrets-guard.js";

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  // Apagar em massa sem -r/-f: rm com glob ou apontado para a casa (compartilhada entre
  // os bots do workspace), find -delete, git clean / descartar o working tree, shred,
  // truncate para zero. O redirecionamento `> arquivo` puro fica de fora (falso positivo).
  /\brm\s+(-[a-z-]+\s+)*[^|;&\n]*(\*|~\/|\/home\/|\$HOME\b|\$\{HOME\})/i,
  /\bfind\b[^|;&\n]*\s-delete\b/i,
  /\bgit\s+(clean\b|checkout\s+--\s+\.(?=\s|$)|restore\s+(-\S+\s+)*\.(?=\s|$))/i,
  /\b(pkill|killall)\b|\bkill\s+(-\S+\s+)*-1(?=\s*$|\s*[;&|)])/i,
  /\bshred\b|\btruncate\b[^|;&\n]*(-s\s*0|--size[=\s]0)\b/i,
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
  /\bwipe\b|\bformat\s+[a-z]:/i,
  /\bsend.*(email|mail|campaign).*(all|blast|bulk|everyone|list)\b/i,
  /\b(stripe|paypal|adyen|charge|invoice|payout|transfer|wire)\b/i,
  /\bpayment\b|\brefund\b/i,
];

const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
  // Perfil e cookies do navegador: o login compartilhado entre os bots do workspace
  // (~/.config/quibt-shared-chromium, Default/Cookies, Default/Login Data).
  /quibt-shared-chromium|\.config\/(chromium|google-chrome)|\/(Cookies|Login Data)\b|\.mozilla\//i,
  /\.git-credentials|\.config\/gh\/hosts\.yml|\.envrc\b/i,
];

const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "execute",
  "run_command",
  "computer_exec",
  "terminal",
]);

const SAFE_COMMANDS = new Set([
  "date",
  "df",
  "du",
  "echo",
  "false",
  "file",
  "id",
  "ls",
  "printf",
  "pwd",
  "stat",
  "true",
  "uname",
  "whereis",
  "which",
  "whoami",
  "xdg-open",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["branch", "ls-files", "rev-parse", "status"]);

/**
 * Com "aprovar automaticamente" desligado, só este vocabulário mínimo roda sem card: um
 * processo só, sem composição, expansão, redirecionamento nem interpretador. Com auto-aprovar
 * ligado (o padrão) a lista não é consultada — comando comum roda de qualquer jeito.
 */
export function commandCanAutoApprove(tool: string, summary: string): boolean {
  if (!COMMAND_TOOLS.has(bareToolName(tool))) return false;
  const command = summary.trim();
  if (!command || /[\r\n;&|`$<>(){}]/.test(command)) return false;
  if (looksDestructive(command) || looksSensitive(command)) return false;
  const words = command.split(/\s+/);
  if (words.some((word) => /^[A-Z_][A-Z0-9_]*=/.test(word)) || words[0] === "sudo") return false;
  const program = (words[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (program === "git") return SAFE_GIT_SUBCOMMANDS.has((words[1] ?? "").toLowerCase());
  return SAFE_COMMANDS.has(program);
}

/** Tools the model can always run without a card. */
export const SAFE_TOOLS = new Set([
  "open_url",
  "memory",
  "remember",
  "save_skill",
  "create_routine",
  "list_teammates",
  "list_bots",
  "ask_bot",
  "message_teammate",
  "run_subagent",
  "request_takeover",
]);

/**
 * Criar ou apagar bot pede card toda vez, com ou sem auto-aprovar, e o card nem oferece
 * "Sempre permitir": a chave seria a ferramenta inteira (não é command tool), e um clique
 * liberaria apagar qualquer bot para sempre.
 */
export const ALWAYS_ASK_TOOLS = new Set(["spawn_bot", "delete_bot"]);

/**
 * SAFE_TOOLS a webhook (unattended) run must not get for free. `create_routine` schedules
 * work that fires later under `trigger:"routine"`, persistent memory/skills poison future
 * runs, and collaboration tools create unbounded descendants. Unattended runs may inspect
 * the roster, but durable or fan-out effects wait for a person.
 */
const UNSAFE_WHEN_UNATTENDED = new Set([
  "memory",
  "remember",
  "save_skill",
  "create_routine",
  "ask_bot",
  "message_teammate",
  "run_subagent",
  "request_takeover",
]);

/** Whether `tool` may skip the approval card outright, independent of `alwaysAllow`/`autoApprove`. */
export function isSafeTool(tool: string, options?: { unattended?: boolean }): boolean {
  if (!SAFE_TOOLS.has(tool)) return false;
  if (options?.unattended && UNSAFE_WHEN_UNATTENDED.has(tool)) return false;
  return true;
}

export function looksDestructive(text: string): boolean {
  return DESTRUCTIVE.some((pattern) => pattern.test(text));
}

export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text));
}

export function toolSummary(tool: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string" && args.command.trim()) return args.command;
  if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd;
  if (typeof args.path === "string" && args.path.trim()) {
    return args.content ? `${args.path}` : args.path;
  }
  if (typeof args.name === "string" && args.name.trim()) return args.name;
  if (typeof args.confirm_name === "string") return args.confirm_name;
  if (typeof args.confirmName === "string") return args.confirmName;
  try {
    return JSON.stringify(args);
  } catch {
    return tool;
  }
}

/**
 * Strips the `mcp__<server>__` prefix an MCP tool carries. The server name may
 * itself contain `_`, so the match is lazy up to the first `__` separator.
 */
const MCP_PREFIX = /^mcp__.+?__/;

/** Bare tool name, with any MCP server prefix removed. */
export function bareToolName(tool: string): string {
  return tool.replace(MCP_PREFIX, "").toLowerCase();
}

function sha256Hex(value: string): string {
  // The shared implementation is synchronous and browser-safe (Vite + Metro).
  return [...sha256(new TextEncoder().encode(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Exact-operation key; old program-wide keys are intentionally no longer honoured. */
export function approvalKey(tool: string, summary: string): string {
  const bare = bareToolName(tool);
  if (!COMMAND_TOOLS.has(bare)) return tool;
  const canonical = summary.trim().replace(/\s+/g, " ");
  return canonical ? `${tool}:exact:${sha256Hex(canonical)}` : `${tool}:invalid`;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Options that narrow what a run may auto-approve. */
export interface AutoDecisionOptions {
  /**
   * True for a run with no human behind it (a webhook trigger, and any peer/spawn hop it
   * causes). `alwaysAllow` and `autoApprove` are the bot's standing consent for a person who
   * can see and answer an approval card; neither means anything when nobody is watching, so
   * every ordinary tool pauses just like a first-time command would for an attended run.
   */
  unattended?: boolean;
}

/**
 * Devolve o motivo quando a ferramenta pode rodar sem card; `null` quando precisa perguntar.
 *
 * O computador é do bot (container, VPS, sandbox), nunca a máquina da pessoa. Por isso, com
 * "aprovar automaticamente" ligado (o padrão de todo bot), um comando de shell comum —
 * `ls`, `xdg-open`, `python3 script.py`, `curl`, `xdotool`, pipes e encadeamentos — roda
 * sem card; uma tarefa de dez cliques não pode virar dez cards e dez reinícios de contexto
 * (decisão do dono, 19/08/2026). O que para sempre, auto-aprovar ou não: destrutivo,
 * sensível, criar/apagar bot (ALWAYS_ASK_TOOLS) e tudo que chega sem ninguém olhando
 * (`unattended`). Com auto-aprovar desligado, todo comando pede, salvo o texto exato que a
 * pessoa já marcou em "Sempre permitir" e o vocabulário mínimo de `commandCanAutoApprove`
 * (`ls`, `pwd`, `git status`…), que não muda nada no computador.
 */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  options?: AutoDecisionOptions,
): string | null {
  if (isSafeTool(tool, options)) return `safe ${tool}`;
  const blob = `${tool} ${summary}`;
  if (looksDestructive(summary) || looksDestructive(tool) || looksDestructive(blob)) return null;
  if (looksSensitive(summary) || looksSensitive(blob)) return null;
  if (options?.unattended) return null;
  if (ALWAYS_ASK_TOOLS.has(tool)) return null;
  const key = approvalKey(tool, summary);
  const commandTool = COMMAND_TOOLS.has(bareToolName(tool));
  if (bot.alwaysAllow?.includes(key) || (!commandTool && bot.alwaysAllow?.includes(tool))) {
    return `auto-approved ${key} (always allowed)`;
  }
  if (bot.autoApprove !== false) return `auto-approved ${tool}`;
  if (commandTool && commandCanAutoApprove(tool, summary)) return "auto-approved safe command";
  return null;
}

/**
 * Se faz sentido oferecer "Sempre permitir" num card.
 *
 * O sim permanente só vale para o que `autoDecision` honra depois: um pedido que parou
 * por ser destrutivo ou sensível vai parar de novo na próxima vez, com ou sem a chave na
 * lista — oferecer o botão ali prometia o que não ia acontecer. Sem ninguém olhando
 * (webhook) não existe consentimento permanente nenhum, e criar/apagar bot
 * (ALWAYS_ASK_TOOLS) pede toda vez. Qualquer outro comando de shell (com pipe, encadeamento,
 * interpretador…) pode: a chave é o hash do texto inteiro, então o sim vale exatamente para
 * aquele texto — só um comando vazio (chave `:invalid`) fica de fora.
 */
export function canAlwaysAllow(
  tool: string,
  summary: string,
  options?: AutoDecisionOptions,
): boolean {
  if (options?.unattended) return false;
  if (ALWAYS_ASK_TOOLS.has(tool)) return false;
  const blob = `${tool} ${summary}`;
  if (looksDestructive(summary) || looksDestructive(tool) || looksDestructive(blob)) return false;
  if (looksSensitive(summary) || looksSensitive(blob)) return false;
  if (COMMAND_TOOLS.has(bareToolName(tool)) && !summary.trim()) return false;
  return true;
}

export type ApprovalDecision = "allow" | "deny" | "always";

export function parseApprovalDecision(value: string): ApprovalDecision | null {
  if (value === "allow" || value === "approved" || value === "Permitir") return "allow";
  if (value === "deny" || value === "denied" || value === "Recusar") return "deny";
  if (value === "always" || value === "Sempre permitir") return "always";
  return null;
}

export interface PendingApproval {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  executionId: string;
  allowKey: string;
  summary: string;
}

/**
 * Nobody was watching an unattended run's card — its actions never even offered "always"
 * (see gatedTool) — so a raw "always" reaching a resume path some other way (a stale
 * checkpoint, a direct DB write, a future caller) must not grant the bot standing consent.
 * Coerce it down to a one-shot "allow": the pending tool still runs once, but alwaysAllow
 * never changes. Attended runs are unaffected.
 */
export function scopeApprovalDecision(
  decision: ApprovalDecision,
  options?: { unattended?: boolean; standingAllowed?: boolean },
): ApprovalDecision {
  if (decision === "always" && (options?.unattended || options?.standingAllowed === false)) {
    return "allow";
  }
  return decision;
}

export function parseRunCheckpoint(raw: string | null | undefined): {
  pendingApproval?: PendingApproval;
  decision?: ApprovalDecision;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      pendingApproval?: PendingApproval;
      decision?: string;
    };
    const decision = parsed.decision ? parseApprovalDecision(parsed.decision) : null;
    return {
      pendingApproval: parsed.pendingApproval,
      decision: decision ?? undefined,
    };
  } catch {
    return {};
  }
}
