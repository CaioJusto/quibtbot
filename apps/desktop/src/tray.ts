export interface TrayPresence {
  pendingApprovalCount: number;
  pendingTakeoverCount: number;
  lastRoutineLabel: string | null;
  lastRoutineAt: string | null;
}

export type TrayMenuItem = {
  id: "open" | "approvals" | "takeover" | "routine" | "quit";
  label: string;
  enabled?: boolean;
};

export interface CloseToTrayPolicy {
  isQuitting: boolean;
}

export const IDLE_TRAY_PRESENCE: TrayPresence = {
  pendingApprovalCount: 0,
  pendingTakeoverCount: 0,
  lastRoutineLabel: null,
  lastRoutineAt: null,
};

const RECENT_ROUTINE_MS = 10 * 60 * 1_000;

function approvalCopy(count: number): string {
  if (count === 1) return "1 aprovação pendente";
  return `${count} aprovações pendentes`;
}

function takeoverCopy(count: number): string {
  if (count === 1) return "1 bot esperando você";
  return `${count} bots esperando você`;
}

function routineCopy(status: TrayPresence): string | null {
  const label = status.lastRoutineLabel?.trim();
  if (label) return `Rotina executada: ${label}`;
  if (status.lastRoutineAt) return "Rotina executada";
  return null;
}

function routineJustFired(status: TrayPresence): boolean {
  if (!status.lastRoutineAt) return Boolean(status.lastRoutineLabel);
  const firedAt = Date.parse(status.lastRoutineAt);
  if (!Number.isFinite(firedAt)) return false;
  const age = Date.now() - firedAt;
  return age >= 0 && age <= RECENT_ROUTINE_MS;
}

function routineMenuCopy(status: TrayPresence): string {
  const routine = routineJustFired(status) ? routineCopy(status) : null;
  if (!routine) return "Nenhuma rotina executada";

  if (!status.lastRoutineAt) return routine;
  const instant = new Date(status.lastRoutineAt);
  if (!Number.isFinite(instant.getTime())) return routine;
  const at = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(instant);
  return `${routine} · ${at}`;
}

export function normalizeTrayPresence(raw: unknown): TrayPresence {
  if (!raw || typeof raw !== "object") return { ...IDLE_TRAY_PRESENCE };
  const input = raw as Record<string, unknown>;
  const count =
    typeof input.pendingApprovalCount === "number" &&
    Number.isFinite(input.pendingApprovalCount) &&
    input.pendingApprovalCount > 0
      ? Math.floor(input.pendingApprovalCount)
      : 0;
  const takeovers =
    typeof input.pendingTakeoverCount === "number" &&
    Number.isFinite(input.pendingTakeoverCount) &&
    input.pendingTakeoverCount > 0
      ? Math.floor(input.pendingTakeoverCount)
      : 0;
  const label =
    typeof input.lastRoutineLabel === "string" && input.lastRoutineLabel.trim()
      ? input.lastRoutineLabel.trim().slice(0, 80)
      : null;
  const at =
    typeof input.lastRoutineAt === "string" && Number.isFinite(Date.parse(input.lastRoutineAt))
      ? new Date(input.lastRoutineAt).toISOString()
      : null;
  return {
    pendingApprovalCount: count,
    pendingTakeoverCount: takeovers,
    lastRoutineLabel: label,
    lastRoutineAt: at,
  };
}

export function trayTooltip(status: TrayPresence): string {
  if (status.pendingTakeoverCount > 0) {
    return `Quibt Bot — ${takeoverCopy(status.pendingTakeoverCount)}`;
  }
  if (status.pendingApprovalCount > 0) {
    return `Quibt Bot — ${approvalCopy(status.pendingApprovalCount)}`;
  }
  const routine = routineCopy(status);
  return routine ? `Quibt Bot — ${routine}` : "Quibt Bot";
}

export function trayTitle(status: TrayPresence): string {
  if (status.pendingTakeoverCount > 0) return takeoverCopy(status.pendingTakeoverCount);
  if (status.pendingApprovalCount > 0) return approvalCopy(status.pendingApprovalCount);
  return routineJustFired(status) ? (routineCopy(status) ?? "") : "";
}

export function trayMenuTemplate(status: TrayPresence): TrayMenuItem[] {
  return [
    { id: "open", label: "Abrir Quibt Bot" },
    {
      id: "approvals",
      label:
        status.pendingApprovalCount > 0
          ? approvalCopy(status.pendingApprovalCount)
          : "Nenhuma aprovação pendente",
      enabled: false,
    },
    {
      id: "takeover",
      label:
        status.pendingTakeoverCount > 0
          ? takeoverCopy(status.pendingTakeoverCount)
          : "Nenhum bot esperando você",
      enabled: false,
    },
    { id: "routine", label: routineMenuCopy(status), enabled: false },
    { id: "quit", label: "Sair" },
  ];
}

export function shouldHideToTrayOnClose({ isQuitting }: CloseToTrayPolicy): boolean {
  return !isQuitting;
}
