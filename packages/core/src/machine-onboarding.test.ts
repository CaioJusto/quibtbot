import { describe, expect, it } from "vitest";
import { listMachineGuides, machineGuideFor } from "./machine-onboarding.js";

describe("machineGuideFor", () => {
  it("returns a full non-technical guide for every catalog kind", () => {
    for (const kind of [
      "docker",
      "remote-supervisor",
      "e2b",
      "box",
      "daytona",
      "vps-hetzner",
      "vps-digitalocean",
      "vps-generic",
    ]) {
      const guide = machineGuideFor(kind);
      expect(guide.kind).toBe(kind);
      expect(guide.headline.length).toBeGreaterThan(10);
      expect(guide.what.length).toBeGreaterThan(40);
      expect(guide.youNeed.length).toBeGreaterThanOrEqual(2);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.botsShare.length).toBeGreaterThan(40);
      expect(guide.cost.length).toBeGreaterThan(10);
    }
  });

  it("maps unknown or empty kinds onto the Docker guide", () => {
    expect(machineGuideFor("").kind).toBe("docker");
    expect(machineGuideFor("desktop").kind).toBe("docker");
    expect(machineGuideFor(undefined).family).toBe("docker");
  });

  it("maps recipe kinds onto the remote-supervisor family", () => {
    expect(machineGuideFor("vps-hetzner").family).toBe("remote-supervisor");
    expect(machineGuideFor("vps-digitalocean").family).toBe("remote-supervisor");
    expect(machineGuideFor("vps-generic").family).toBe("remote-supervisor");
  });

  it("never describes a bot as a browser tab", () => {
    for (const guide of listMachineGuides()) {
      expect(guide.botsShare.toLowerCase()).not.toMatch(/cada bot (abre|ganha) uma aba/);
      expect(guide.botsShare).toMatch(/não é (uma )?aba|Não é aba|não emula/i);
    }
  });

  it("tells cloud sandbox owners where to get a key", () => {
    expect(machineGuideFor("e2b").keyUrl).toMatch(/e2b\.dev/);
    expect(machineGuideFor("box").keyUrl).toMatch(/ascii\.dev|box\.ascii/);
    expect(machineGuideFor("daytona").keyUrl).toMatch(/daytona\.io/);
    expect(machineGuideFor("docker").keyUrl).toBeUndefined();
  });

  it("explains the Box trial auto-stop and saved-key reuse before activation", () => {
    const guide = machineGuideFor("box");
    const copy = [guide.what, ...guide.youNeed, ...guide.steps, guide.cost].join("\n");
    expect(copy).toMatch(/2 horas/i);
    expect(copy).toMatch(/chave salva.*reutilizada|desbloqueie a chave salva/i);
    expect(copy).toMatch(/preserva o disco/i);
  });

  it("says Docker bots share one computer and cloud sandboxes do not", () => {
    expect(machineGuideFor("docker").botsShare).toMatch(/mesmo computador/i);
    expect(machineGuideFor("e2b").botsShare).toMatch(/Não compartilham/);
    expect(machineGuideFor("box").botsShare).toMatch(/Não compartilham/);
    expect(machineGuideFor("daytona").botsShare).toMatch(/Não compartilham/);
  });

  it("spells out one graphical desktop per bot for Docker and the remote supervisor", () => {
    expect(machineGuideFor("docker").botsShare).toMatch(/desktop gráfico por bot/i);
    expect(machineGuideFor("remote-supervisor").botsShare).toMatch(/desktop gráfico por bot/i);
  });

  it("spells out one sandbox per bot for E2B and one VM per bot for Box", () => {
    expect(machineGuideFor("e2b").botsShare).toMatch(/um sandbox por bot/i);
    expect(machineGuideFor("box").botsShare).toMatch(/uma VM por bot/i);
  });

  it("lists every secret the Compose stack refuses to boot without, on the VPS guides", () => {
    // O Compose fixa NODE_ENV=production e recusa segredo ausente, curto ou ainda começando com
    // `replace-with-` (packages/core/src/secrets-guard.ts). Um guia que só pede dois segredos
    // deixa a pessoa com um stack que não sobe.
    for (const kind of ["remote-supervisor", "vps-hetzner", "vps-digitalocean", "vps-generic"]) {
      const text = machineGuideFor(kind).steps.join("\n");
      expect(text, `${kind} must name BETTER_AUTH_SECRET`).toContain("BETTER_AUTH_SECRET");
      expect(text, `${kind} must name ENCRYPTION_KEY`).toContain("ENCRYPTION_KEY");
      expect(text, `${kind} must name SANDBOX_SUPERVISOR_TOKEN`).toContain(
        "SANDBOX_SUPERVISOR_TOKEN",
      );
      expect(text, `${kind} must name BOOTSTRAP_SECRET`).toContain("BOOTSTRAP_SECRET");
      expect(text, `${kind} must offer the mailer choice`).toMatch(
        /RESEND_API_KEY[^\n]*AUTH_EMAIL_DISABLED/,
      );
      expect(text, `${kind} must warn about the published placeholder`).toContain("replace-with-");
    }
  });

  it("tells a VPS owner that entry is by password or code, never automatic", () => {
    // `POST /api/local/session` responde 404 fora de loopback (apps/api/src/app.ts): numa VPS
    // ninguém entra sozinho.
    for (const kind of ["remote-supervisor", "vps-hetzner", "vps-digitalocean", "vps-generic"]) {
      const guide = machineGuideFor(kind);
      const text = [guide.what, ...guide.youNeed, ...guide.steps].join("\n");
      expect(text, kind).toMatch(/(entrar|entra)[^\n]{0,140}(código|senha)/i);
      expect(text, kind).not.toMatch(/entra sozinho|entrada automática (funciona|vale)/i);
    }
  });

  it("tells the VPS owner about the SSH live screen and the whole-stack path", () => {
    // A porta 7091 não é publicada; o operador liga o profile `supervisor-tls` (Caddy, 443) no
    // host do computador, ou cola um alias SSH para a tela chegar ao notebook por túnel.
    for (const kind of ["remote-supervisor", "vps-hetzner", "vps-digitalocean", "vps-generic"]) {
      const guide = machineGuideFor(kind);
      const text = [guide.what, ...guide.youNeed, ...guide.steps, guide.botsShare].join("\n");
      expect(text, `${kind} must not teach the unpublished port`).not.toMatch(
        /https?:\/\/[^\s"']*:7091/,
      );
      expect(text, `${kind} must name the opt-in profile`).toContain("supervisor-tls");
      expect(text, `${kind} must describe the SSH live screen`).toMatch(
        /túnel SSH|alias SSH|127\.0\.0\.1/i,
      );
      expect(text, `${kind} must not claim the screen stays black`).not.toMatch(
        /painel do computador fica preto|tela não atravessa/i,
      );
      expect(text, `${kind} must recommend the whole stack`).toMatch(
        /stack (inteiro|todo)|instale o Quibt inteiro/i,
      );
    }
  });

  it("never lets a cloud sandbox guide claim it hosts the Quibt server, only the bot's computer", () => {
    for (const kind of ["e2b", "box", "daytona"]) {
      const guide = machineGuideFor(kind);
      expect(`${guide.headline} ${guide.what}`).not.toMatch(
        /hospeda o servidor|é o servidor Quibt/i,
      );
    }
  });
});
