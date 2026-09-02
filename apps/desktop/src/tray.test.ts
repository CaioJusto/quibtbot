import { describe, expect, it, vi } from "vitest";
import {
  shouldHideToTrayOnClose,
  type TrayPresence,
  trayMenuTemplate,
  trayTooltip,
} from "./tray.js";

// Keep this suite headless even if the pure tray model accidentally gains an Electron import.
vi.mock("electron", () => ({}));

function presence(input: Partial<TrayPresence> = {}): TrayPresence {
  return {
    pendingApprovalCount: 0,
    pendingTakeoverCount: 0,
    lastRoutineLabel: null,
    lastRoutineAt: null,
    ...input,
  };
}

describe("desktop tray presence", () => {
  it("uses the product name while idle", () => {
    expect(trayTooltip(presence())).toBe("Quibt Bot");
  });

  it("uses distinct Portuguese approval copy for one and many", () => {
    expect(trayTooltip(presence({ pendingApprovalCount: 1 }))).toContain("1 aprovação pendente");
    expect(trayTooltip(presence({ pendingApprovalCount: 2 }))).toContain("2 aprovações pendentes");
  });

  it("mentions a recently fired routine", () => {
    const status = presence({
      lastRoutineLabel: "Resumo da manhã",
      lastRoutineAt: new Date().toISOString(),
    });
    expect(trayTooltip(status).toLocaleLowerCase("pt-BR")).toContain("rotina");
    expect(trayMenuTemplate(status)[3]?.label.toLocaleLowerCase("pt-BR")).toContain("rotina");
  });

  it("keeps open, approval, routine, and quit in order", () => {
    expect(trayMenuTemplate(presence()).map((item) => item.label)).toEqual([
      "Abrir Quibt Bot",
      "Nenhuma aprovação pendente",
      "Nenhum bot esperando você",
      "Nenhuma rotina executada",
      "Sair",
    ]);
  });

  it("mentions a bot waiting for takeover before approvals", () => {
    const status = presence({ pendingTakeoverCount: 1 });
    expect(trayTooltip(status)).toContain("1 bot esperando você");
    expect(trayMenuTemplate(status).map((item) => item.id)).toEqual([
      "open",
      "approvals",
      "takeover",
      "routine",
      "quit",
    ]);
  });
});

describe("close-to-tray policy", () => {
  it("hides on close unless the app is quitting", () => {
    expect(shouldHideToTrayOnClose({ isQuitting: false })).toBe(true);
    expect(shouldHideToTrayOnClose({ isQuitting: true })).toBe(false);
  });
});
